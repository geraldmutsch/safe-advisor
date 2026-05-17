#!/usr/bin/env python3
"""BMW Dashboard – Backend using bimmer-connected (https://github.com/bimmerconnected/bimmer_connected)"""

import asyncio
import secrets
from datetime import datetime, timezone
from flask import Flask, jsonify, request, send_from_directory, session

app = Flask(__name__, static_folder='public', static_url_path='')
app.secret_key = secrets.token_hex(32)

# In-memory session store: session_id -> MyBMWAccount
_store: dict = {}

REGION_MAP = {
    'eu':  'rest_of_world',
    'us':  'north_america',
    'cn':  'china',
    'row': 'rest_of_world',
}

def arun(coro):
    """Run an async coroutine from synchronous Flask handlers."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop.run_until_complete(coro)
    except RuntimeError:
        return asyncio.run(coro)

def get_account():
    sid = session.get('sid')
    return _store.get(sid) if sid else None

def safe_get(fn, default=None):
    try:
        return fn()
    except Exception:
        return default

# ── Static ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/api/status')
def status():
    return jsonify({'authenticated': bool(get_account())})

@app.route('/api/login', methods=['POST'])
def login():
    from bimmer_connected.account import MyBMWAccount
    from bimmer_connected.api.regions import get_region_from_name

    data = request.get_json() or {}
    email         = (data.get('email') or '').strip()
    password      = data.get('password') or ''
    region        = REGION_MAP.get(data.get('region', 'eu'), 'rest_of_world')
    captcha_token = data.get('captcha_token') or ''

    if not email or not password:
        return jsonify({'error': 'E-Mail und Passwort erforderlich'}), 400
    if not captcha_token:
        return jsonify({'error': 'Captcha-Token fehlt. Bitte Captcha auf der verlinkten Seite lösen.'}), 400

    try:
        account = MyBMWAccount(email, password, get_region_from_name(region),
                               hcaptcha_token=captcha_token)
        arun(account.get_vehicles())

        sid = secrets.token_hex(16)
        _store[sid] = account
        session['sid'] = sid
        return jsonify({'success': True})

    except Exception as e:
        msg = str(e)
        if any(k in msg.lower() for k in ('credential', '401', 'password', 'login', 'invalid')):
            return jsonify({'error': f'Zugangsdaten falsch: {msg}'}), 401
        return jsonify({'error': f'Verbindungsfehler: {msg}'}), 500

@app.route('/api/logout', methods=['POST'])
def logout():
    sid = session.pop('sid', None)
    if sid:
        _store.pop(sid, None)
    return jsonify({'success': True})

# ── Vehicles ──────────────────────────────────────────────────────────────────

@app.route('/api/vehicles')
def vehicles():
    account = get_account()
    if not account:
        return jsonify({'error': 'Nicht angemeldet'}), 401

    result = []
    for v in account.vehicles:
        result.append({
            'vin': v.vin,
            'attributes': {
                'model':     v.name,
                'modelName': v.name,
                'driveTrain': safe_get(lambda: v.drive_train.value, 'BEV'),
            }
        })
    return jsonify(result)

@app.route('/api/state/<vin>')
def vehicle_state(vin):
    account = get_account()
    if not account:
        return jsonify({'error': 'Nicht angemeldet'}), 401

    # Refresh vehicle data
    try:
        arun(account.get_vehicles())
    except Exception:
        pass

    vehicle = next((v for v in account.vehicles if v.vin == vin), None)
    if not vehicle:
        return jsonify({'error': 'Fahrzeug nicht gefunden'}), 404

    state = {}

    # Mileage
    mileage = safe_get(lambda: vehicle.mileage)
    if mileage:
        state['currentMileage'] = mileage[0]

    # Battery / charging
    fb = safe_get(lambda: vehicle.fuel_and_battery)
    if fb:
        elec = {
            'chargingLevelPercent': safe_get(lambda: fb.remaining_battery_percent),
            'chargingStatus':       safe_get(lambda: fb.charging_status.value),
            'isChargerConnected':   safe_get(lambda: fb.is_charger_connected, False),
            'chargingTarget':       safe_get(lambda: fb.charging_target),
        }
        rng = safe_get(lambda: fb.remaining_range_electric)
        if rng:
            elec['range'] = rng[0]
        state['electricChargingState'] = elec

    # GPS location
    gps = safe_get(lambda: vehicle.status.gps_position)
    if gps:
        state['location'] = {
            'coordinates': {'latitude': gps[0], 'longitude': gps[1]}
        }

    # Doors / lids
    lids = safe_get(lambda: vehicle.status.lids, [])
    if lids:
        doors = {}
        for lid in lids:
            lid_id = safe_get(lambda: lid.id.value, 'unknown')
            doors[lid_id] = 'CLOSED' if safe_get(lambda: lid.is_closed, True) else 'OPEN'
        state['doorsState'] = doors

    # Windows
    all_windows = safe_get(lambda: vehicle.status.all_windows_closed)
    if all_windows is not None:
        state['windowsState'] = {'allClosed': all_windows}

    # Condition Based Services
    cbs_list = safe_get(lambda: vehicle.status.condition_based_services, [])
    if cbs_list:
        cbs = []
        for s in cbs_list:
            cbs.append({
                'cbsType':     safe_get(lambda: s.service_type.value, ''),
                'description': safe_get(lambda: s.service_type.value.replace('_', ' ').title(), ''),
                'state':       safe_get(lambda: s.state.value, 'UNKNOWN'),
                'dueDate':     safe_get(lambda: s.due_date.isoformat() if s.due_date else None),
            })
        state['conditionBasedServices'] = cbs

    # Check control messages
    ccm = safe_get(lambda: vehicle.status.check_control_messages, [])
    if ccm:
        state['checkControlMessages'] = [
            {'description': safe_get(lambda: m.description_short, ''), 'state': 'INFO'}
            for m in ccm
        ]

    return jsonify({'state': state})

@app.route('/api/charging/<vin>')
def charging(vin):
    account = get_account()
    if not account:
        return jsonify({'error': 'Nicht angemeldet'}), 401

    vehicle = next((v for v in account.vehicles if v.vin == vin), None)
    if not vehicle:
        return jsonify({'error': 'Fahrzeug nicht gefunden'}), 404

    fb = safe_get(lambda: vehicle.fuel_and_battery)
    if not fb:
        return jsonify({'chargingState': {}})

    remaining_min = None
    end_time = safe_get(lambda: fb.charging_end_time)
    if end_time:
        if end_time.tzinfo is None:
            end_time = end_time.replace(tzinfo=timezone.utc)
        diff = (end_time - datetime.now(timezone.utc)).total_seconds() / 60
        remaining_min = max(0, int(diff))

    return jsonify({
        'chargingState': {
            'chargingLevelPercent':    safe_get(lambda: fb.remaining_battery_percent),
            'isChargerConnected':      safe_get(lambda: fb.is_charger_connected, False),
            'chargingStatus':          safe_get(lambda: fb.charging_status.value),
            'chargingTarget':          safe_get(lambda: fb.charging_target),
            'remainingChargingMinutes': remaining_min,
        }
    })

# These endpoints require raw API access not covered by bimmer_connected
# They return empty data gracefully so the dashboard still renders
@app.route('/api/lasttrip')
def last_trip():
    return jsonify({})

@app.route('/api/alltime')
def alltime():
    return jsonify({})

@app.route('/api/sessions')
def sessions_route():
    return jsonify([])

# ── Start ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('\n  BMW Dashboard ▸  http://localhost:3001\n')
    app.run(host='0.0.0.0', port=3001, debug=False)
