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
        'Accept': 'application/json',
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
    """Build state from CarData endpoints. Battery SoC via chargeHistory latest entry."""
    err = _require_auth()
    if err: return err
    store = _get_store()
    headers = _headers(store['access_token'])
    state = {}

    # Basic data
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/basicData',
                      headers=headers, timeout=15)
        if r.is_success:
            bd = r.json()
            state['currentMileage'] = bd.get('mileage') or bd.get('odometer')
    except Exception:
        pass

    # Charge history → derive latest SoC and last charge
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/chargeHistory',
                      headers=headers, timeout=15)
        if r.is_success:
            history = r.json()
            sessions = history if isinstance(history, list) else history.get('chargeHistory', [])
            if sessions:
                latest = sessions[-1]
                soc = latest.get('socAfterCharging') or latest.get('stateOfCharge')
                state['electricChargingState'] = {
                    'chargingLevelPercent': soc,
                    'chargingStatus': 'STANDBY',
                    'isChargerConnected': False,
                }
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
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/chargeHistory',
                      headers=_headers(store['access_token']), timeout=15)
        r.raise_for_status()
        history = r.json()
        sessions = history if isinstance(history, list) else history.get('chargeHistory', [])
        latest = sessions[-1] if sessions else {}
        return jsonify({
            'chargingState': {
                'chargingLevelPercent':  latest.get('socAfterCharging') or latest.get('stateOfCharge'),
                'isChargerConnected':    False,
                'chargingStatus':        'STANDBY',
                'chargingTarget':        latest.get('targetSoc'),
                'remainingChargingMinutes': None,
            }
        })
    except Exception as e:
        return jsonify({'chargingState': {}, 'error': str(e)})

@app.route('/api/sessions')
def sessions_route():
    # Use first vehicle from store if we have VIN
    err = _require_auth()
    if err: return err
    # VIN passed as query param from frontend
    vin = request.args.get('vin', '')
    if not vin:
        return jsonify([])
    store = _get_store()
    try:
        r = httpx.get(f'{CARDATA_API}/customers/vehicles/{vin}/chargeHistory',
                      headers=_headers(store['access_token']), timeout=15)
        r.raise_for_status()
        history = r.json()
        sessions = history if isinstance(history, list) else history.get('chargeHistory', [])
        result = []
        for s in sessions[-10:]:
            result.append({
                'date':          s.get('startTime') or s.get('timestamp'),
                'energyCharged': s.get('energyCharged') or s.get('chargedEnergy'),
            })
        return jsonify(result)
    except Exception:
        return jsonify([])

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
