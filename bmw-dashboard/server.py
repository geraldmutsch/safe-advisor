#!/usr/bin/env python3
"""BMW Dashboard – BMW CarData Official API (OAuth2 Device Code Flow)"""

import hashlib
import secrets
import time
from base64 import urlsafe_b64encode

import httpx
from flask import Flask, jsonify, request, send_from_directory, session

app = Flask(__name__, static_folder='public', static_url_path='')
app.secret_key = secrets.token_hex(32)

CARDATA_API   = 'https://api-cardata.bmwgroup.com'
OAUTH_BASE    = 'https://customer.bmwgroup.com/gcdm/oauth'
SCOPE         = 'authenticate_user openid cardata:api:read cardata:streaming:read'

# In-memory store: session_id -> token info
_store: dict = {}
# Pending device-code auth flows: device_code -> {client_id, verifier, expires, ...}
_pending: dict = {}

# ── Telematics key → structured state ────────────────────────────────────────

def _parse_telematics(items):
    """Convert [{name, value, ...}] list to flat {key: value} dict."""
    if not isinstance(items, list):
        return {}
    return {i['name']: i.get('value') for i in items if 'name' in i}

def _telematics_to_state(td):
    state = {}

    # Mileage
    raw = td.get('vehicle.vehicle.travelledDistance')
    if raw is not None:
        try: state['currentMileage'] = float(raw)
        except: pass

    # Battery / charging
    soc     = td.get('vehicle.powertrain.electric.battery.stateOfCharge')
    rrange  = td.get('vehicle.powertrain.electric.battery.remainingRange')
    cstatus = (td.get('vehicle.powertrain.electric.battery.charging.status') or
               td.get('vehicle.drivetrain.electricEngine.charging.status'))
    cpower  = td.get('vehicle.powertrain.electric.battery.charging.power')
    if any(v is not None for v in (soc, rrange, cstatus)):
        try:
            state['electricChargingState'] = {
                'chargingLevelPercent': float(soc)    if soc    is not None else None,
                'range':                float(rrange) if rrange is not None else None,
                'chargingStatus':       cstatus or 'STANDBY',
                'isChargerConnected':   cstatus not in (None, 'NOT_CHARGING', 'STANDBY'),
                'chargingPower':        float(cpower) if cpower is not None else None,
            }
        except: pass

    # GPS
    lat = td.get('vehicle.cabin.infotainment.navigation.currentLocation.latitude')
    lon = td.get('vehicle.cabin.infotainment.navigation.currentLocation.longitude')
    if lat is not None and lon is not None:
        try:
            state['location'] = {'latitude': float(lat), 'longitude': float(lon)}
        except: pass

    # Doors
    door_map = {
        'leftFront':  'vehicle.cabin.door.row1.driver.isOpen',
        'rightFront': 'vehicle.cabin.door.row1.passenger.isOpen',
        'leftRear':   'vehicle.cabin.door.row2.driver.isOpen',
        'rightRear':  'vehicle.cabin.door.row2.passenger.isOpen',
    }
    doors = {}
    for key, tkey in door_map.items():
        val = td.get(tkey)
        if val is not None:
            doors[key] = 'OPEN' if str(val).lower() in ('true', '1', 'open') else 'CLOSED'
    if doors:
        state['doorsState'] = doors

    return state

# ── PKCE helpers ─────────────────────────────────────────────────────────────

def _pkce():
    verifier = urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b'=').decode()
    challenge = urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b'=').decode()
    return verifier, challenge

# ── Auth helpers ──────────────────────────────────────────────────────────────

def _headers(access_token):
    return {
        'Authorization': f'Bearer {access_token}',
        'Accept':        'application/json',
        'x-version':     'v1',
    }

def _get_store():
    sid = session.get('sid')
    return _store.get(sid) if sid else None

def _require_auth():
    s = _get_store()
    if not s:
        return jsonify({'error': 'Nicht angemeldet'}), 401
    # Refresh token if expired
    if s.get('expires_at', 0) < time.time() + 60:
        try:
            _refresh(s)
        except Exception as e:
            return jsonify({'error': f'Token abgelaufen: {e}'}), 401
    return None

def _refresh(store_entry):
    client_id     = store_entry['client_id']
    refresh_token = store_entry['refresh_token']
    r = httpx.post(f'{OAUTH_BASE}/token', data={
        'grant_type':    'refresh_token',
        'client_id':     client_id,
        'refresh_token': refresh_token,
    }, timeout=15)
    r.raise_for_status()
    data = r.json()
    store_entry['access_token']  = data['access_token']
    store_entry['expires_at']    = time.time() + data.get('expires_in', 3600)
    if 'refresh_token' in data:
        store_entry['refresh_token'] = data['refresh_token']

# ── Static ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

# ── Auth flow ─────────────────────────────────────────────────────────────────

@app.route('/api/status')
def status():
    return jsonify({'authenticated': bool(_get_store())})

@app.route('/api/device-code', methods=['POST'])
def device_code():
    """Step 1: initiate Device Code flow — returns user_code + verification_uri."""
    data = request.get_json() or {}
    client_id = (data.get('client_id') or '').strip()
    if not client_id:
        return jsonify({'error': 'Bitte Client ID eingeben'}), 400

    verifier, challenge = _pkce()
    try:
        r = httpx.post(f'{OAUTH_BASE}/device/code', data={
            'client_id':             client_id,
            'response_type':         'device_code',
            'scope':                 SCOPE,
            'code_challenge':        challenge,
            'code_challenge_method': 'S256',
        }, timeout=15)
        r.raise_for_status()
    except httpx.HTTPStatusError as e:
        return jsonify({'error': f'BMW CarData Fehler: {e.response.text[:200]}'}), 400
    except Exception as e:
        return jsonify({'error': f'Verbindungsfehler: {e}'}), 500

    resp = r.json()
    device_code_val = resp['device_code']
    _pending[device_code_val] = {
        'client_id': client_id,
        'verifier':  verifier,
        'interval':  resp.get('interval', 5),
        'expires':   time.time() + resp.get('expires_in', 600),
    }

    return jsonify({
        'device_code':              device_code_val,
        'user_code':                resp['user_code'],
        'verification_uri':         resp.get('verification_uri', ''),
        'verification_uri_complete': resp.get('verification_uri_complete', ''),
        'expires_in':               resp.get('expires_in', 600),
        'interval':                 resp.get('interval', 5),
    })

@app.route('/api/poll-token', methods=['POST'])
def poll_token():
    """Step 2: poll for token after user has authorized on BMW website."""
    data        = request.get_json() or {}
    device_code_val = data.get('device_code', '')
    pending     = _pending.get(device_code_val)
    if not pending:
        return jsonify({'error': 'Unbekannter Device Code'}), 400
    if time.time() > pending['expires']:
        del _pending[device_code_val]
        return jsonify({'error': 'Device Code abgelaufen, bitte neu starten'}), 400

    try:
        r = httpx.post(f'{OAUTH_BASE}/token', data={
            'grant_type':    'urn:ietf:params:oauth:grant-type:device_code',
            'client_id':     pending['client_id'],
            'device_code':   device_code_val,
            'code_verifier': pending['verifier'],
        }, timeout=15)
    except Exception as e:
        return jsonify({'error': f'Verbindungsfehler: {e}'}), 500

    # Parse body regardless of HTTP status — BMW may use non-400 for pending states
    try:
        body = r.json()
    except Exception:
        body = {}

    err_code = body.get('error', '')
    if err_code == 'authorization_pending':
        return jsonify({'status': 'pending'}), 202
    if err_code == 'slow_down':
        return jsonify({'status': 'slow_down'}), 202
    if err_code:
        return jsonify({'error': body.get('error_description', err_code)}), 400

    if not r.is_success:
        return jsonify({'error': r.text[:300]}), 400

    token_data = body
    sid = secrets.token_hex(16)
    _store[sid] = {
        'client_id':     pending['client_id'],
        'access_token':  token_data['access_token'],
        'refresh_token': token_data.get('refresh_token', ''),
        'expires_at':    time.time() + token_data.get('expires_in', 3600),
    }
    session['sid'] = sid
    del _pending[device_code_val]
    return jsonify({'status': 'authorized'})

@app.route('/api/logout', methods=['POST'])
def logout():
    sid = session.pop('sid', None)
    if sid:
        _store.pop(sid, None)
    return jsonify({'success': True})

# ── CarData API endpoints ─────────────────────────────────────────────────────

@app.route('/api/vehicles')
def vehicles():
    err = _require_auth()
    if err: return err
    store = _get_store()
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/mappings',
                      headers=_headers(store['access_token']), timeout=15)
        r.raise_for_status()
        mappings = r.json()
        result = []
        for v in (mappings if isinstance(mappings, list) else mappings.get('vehicles', [])):
            vin = v.get('vin') or v.get('vehicleVin') or v.get('id', '')
            result.append({
                'vin': vin,
                'attributes': {
                    'model':     v.get('model') or v.get('modelName') or v.get('name', 'BMW'),
                    'modelName': v.get('model') or v.get('modelName') or v.get('name', 'BMW'),
                    'driveTrain': v.get('driveTrain', 'BEV'),
                    'year': v.get('year') or v.get('modelYear'),
                }
            })
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/basic/<vin>')
def basic_data(vin):
    err = _require_auth()
    if err: return err
    store = _get_store()
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/basicData',
                      headers=_headers(store['access_token']), timeout=15)
        r.raise_for_status()
        return jsonify(r.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/state/<vin>')
def vehicle_state(vin):
    err = _require_auth()
    if err: return err
    store = _get_store()
    headers = _headers(store['access_token'])
    state = {}

    # Basic data (mileage, model info)
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/basicData',
                      headers=headers, timeout=15)
        if r.is_success:
            bd = r.json()
            state['currentMileage'] = bd.get('mileage') or bd.get('currentMileage') or bd.get('odometer')
    except Exception:
        pass

    # Telematics data → SoC, range, location, doors (flat key-value list)
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/telematicData',
                      headers=headers, timeout=15)
        if r.is_success:
            td = _telematics_to_state(_parse_telematics(r.json()))
            state.update(td)
    except Exception:
        pass

    # Tire data
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/tireData',
                      headers=headers, timeout=15)
        if r.is_success:
            state['tireData'] = r.json()
    except Exception:
        pass

    return jsonify({'state': state})

@app.route('/api/charging/<vin>')
def charging(vin):
    err = _require_auth()
    if err: return err
    store = _get_store()
    # Try telematicData first, fall back to chargingHistory
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/telematicData',
                      headers=_headers(store['access_token']), timeout=15)
        if r.is_success:
            td = r.json()
            elec = td.get('electricChargingState') or td.get('chargingState') or {}
            return jsonify({'chargingState': elec})
    except Exception:
        pass
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/chargingHistory',
                      headers=_headers(store['access_token']), timeout=15)
        if r.is_success:
            history = r.json()
            sessions = history if isinstance(history, list) else history.get('chargingHistory', [])
            latest = sessions[-1] if sessions else {}
            return jsonify({
                'chargingState': {
                    'chargingLevelPercent': latest.get('socAfterCharging') or latest.get('stateOfCharge'),
                    'isChargerConnected':   False,
                    'chargingStatus':       'STANDBY',
                    'chargingTarget':       latest.get('targetSoc'),
                }
            })
    except Exception as e:
        pass
    return jsonify({'chargingState': {}})

@app.route('/api/sessions')
def sessions_route():
    err = _require_auth()
    if err: return err
    vin = request.args.get('vin', '')
    if not vin:
        return jsonify([])
    store = _get_store()
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/chargingHistory',
                      headers=_headers(store['access_token']), timeout=15)
        r.raise_for_status()
        history = r.json()
        sessions = history if isinstance(history, list) else history.get('chargingHistory', [])
        result = []
        for s in sessions[-10:]:
            result.append({
                'date':          s.get('startTime') or s.get('timestamp'),
                'energyCharged': s.get('energyCharged') or s.get('chargedEnergy'),
            })
        return jsonify(result)
    except Exception:
        return jsonify([])

@app.route('/api/raw/<vin>')
def raw_data(vin):
    """Debug: returns raw BMW API responses for all endpoints."""
    err = _require_auth()
    if err: return err
    store = _get_store()
    h = _headers(store['access_token'])
    out = {}
    for name, path in [
        ('basicData',      f'/customers/vehicles/{vin}/basicData'),
        ('telematicData',  f'/customers/vehicles/{vin}/telematicData'),
        ('chargingHistory',f'/customers/vehicles/{vin}/chargingHistory'),
        ('tireData',       f'/customers/vehicles/{vin}/tireData'),
    ]:
        try:
            r = httpx.get(f'{CARDATA_API}{path}', headers=h, timeout=15)
            out[name] = {'status': r.status_code, 'body': r.json() if r.is_success else r.text[:300]}
        except Exception as e:
            out[name] = {'error': str(e)}
    return jsonify(out)

@app.route('/api/lasttrip')
def last_trip():
    return jsonify({})

@app.route('/api/alltime')
def alltime():
    return jsonify({})

# ── Start ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('\n  BMW Dashboard ▸  http://localhost:3001\n')
    print('  Verwendet BMW CarData Official API')
    print('  Client ID nötig: https://bmw-cardata.bmwgroup.com\n')
    app.run(host='0.0.0.0', port=3001, debug=False)
