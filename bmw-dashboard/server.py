#!/usr/bin/env python3
"""BMW Dashboard – Demo mode with realistic BEV data.

NOTE: BMW blocked all third-party API access in 2025. The bimmer_connected
library itself warns: 'non-functional due to changes in the MyBMW API.'
This server runs in Demo Mode with realistic sample data until BMW provides
an official developer API or a working workaround becomes available.
"""

import secrets
from datetime import datetime, timezone, timedelta
from flask import Flask, jsonify, request, send_from_directory, session

app = Flask(__name__, static_folder='public', static_url_path='')
app.secret_key = secrets.token_hex(32)

# ── Demo data ─────────────────────────────────────────────────────────────────

DEMO_VEHICLES = [
    {
        'vin': 'WBY1Z210X0V123456',
        'attributes': {
            'model': 'BMW iX xDrive50',
            'modelName': 'BMW iX xDrive50',
            'driveTrain': 'BEV',
            'year': 2024,
        }
    }
]

def make_demo_state():
    now = datetime.now(timezone.utc)
    return {
        'state': {
            'currentMileage': 18742,
            'electricChargingState': {
                'chargingLevelPercent': 78,
                'range': 312,
                'chargingStatus': 'STANDBY',
                'isChargerConnected': False,
                'chargingTarget': 80,
            },
            'doorsState': {
                'leftFront':  'CLOSED',
                'rightFront': 'CLOSED',
                'leftRear':   'CLOSED',
                'rightRear':  'CLOSED',
                'hood':       'CLOSED',
                'trunk':      'CLOSED',
            },
            'windowsState': {'allClosed': True},
            'location': {
                'coordinates': {'latitude': 48.1351, 'longitude': 11.5820},
                'address': {'formatted': 'Petuelring 130, 80809 München'}
            },
            'conditionBasedServices': [
                {'cbsType': 'BRAKE_FLUID', 'description': 'Bremsflüssigkeit', 'state': 'OK',   'dueDate': '2026-08-01'},
                {'cbsType': 'VEHICLE_CHECK', 'description': 'Fahrzeugcheck',  'state': 'OK',   'dueDate': '2026-03-15'},
                {'cbsType': 'AIR_CONDITIONER', 'description': 'Klimaanlage',  'state': 'OK',   'dueDate': '2025-10-01'},
            ],
        }
    }

def make_demo_charging():
    return {
        'chargingState': {
            'chargingLevelPercent': 78,
            'isChargerConnected': False,
            'chargingStatus': 'STANDBY',
            'chargingTarget': 80,
            'remainingChargingMinutes': None,
            'chargingConnectionType': 'NONE',
            'chargingPower': None,
        }
    }

def make_demo_lasttrip():
    return {
        'lastTrip': {
            'totalDistance': 43200,       # metres → 43.2 km
            'totalDuration': 2520,        # seconds → 42 min
            'totalEnergyConsumption': 16.8,
            'totalRecuperatedEnergy': 3.2,
        }
    }

def make_demo_alltime():
    return {
        'statistics': {
            'totalDistance': 18742000,       # metres → 18 742 km
            'totalElectricDistance': 18742000,
            'totalEnergyCharged': 3840.5,
            'totalRecuperatedEnergy': 620.3,
        }
    }

def make_demo_sessions():
    base = datetime.now(timezone.utc)
    sessions = []
    kwh_values = [28.4, 12.1, 44.7, 8.3, 36.2, 19.8, 52.1, 6.4, 41.3, 23.9]
    for i, kwh in enumerate(kwh_values):
        sessions.append({
            'date': (base - timedelta(days=i * 3)).isoformat(),
            'energyCharged': kwh,
        })
    return list(reversed(sessions))

# ── Auth ──────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@app.route('/api/status')
def status():
    return jsonify({'authenticated': session.get('demo', False)})

@app.route('/api/login', methods=['POST'])
def login():
    # Demo mode: accept any credentials
    session['demo'] = True
    return jsonify({'success': True, 'demo': True})

@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'success': True})

# ── Data endpoints ────────────────────────────────────────────────────────────

def require_auth():
    if not session.get('demo'):
        return jsonify({'error': 'Nicht angemeldet'}), 401
    return None

@app.route('/api/vehicles')
def vehicles():
    err = require_auth()
    if err: return err
    return jsonify(DEMO_VEHICLES)

@app.route('/api/state/<vin>')
def vehicle_state(vin):
    err = require_auth()
    if err: return err
    return jsonify(make_demo_state())

@app.route('/api/charging/<vin>')
def charging(vin):
    err = require_auth()
    if err: return err
    return jsonify(make_demo_charging())

@app.route('/api/lasttrip')
def last_trip():
    err = require_auth()
    if err: return err
    return jsonify(make_demo_lasttrip())

@app.route('/api/alltime')
def alltime():
    err = require_auth()
    if err: return err
    return jsonify(make_demo_alltime())

@app.route('/api/sessions')
def sessions_route():
    err = require_auth()
    if err: return err
    return jsonify(make_demo_sessions())

# ── Start ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('\n  BMW Dashboard (Demo-Modus) ▸  http://localhost:3001\n')
    print('  HINWEIS: BMW hat die API für Drittanbieter gesperrt.')
    print('  Das Dashboard läuft mit realistischen Beispieldaten.\n')
    app.run(host='0.0.0.0', port=3001, debug=False)
