'use strict';

// ── hCaptcha ───────────────────────────────────────────────────────────────
// Site keys from bimmer_connected const.py
const HCAPTCHA_KEYS = {
  eu:  '10000000-ffff-ffff-ffff-000000000001', // test key — simple checkbox
  row: '10000000-ffff-ffff-ffff-000000000001',
  us:  'dc24de9a-9844-438b-b542-60067ff4dbe9',
  cn:  '10000000-ffff-ffff-ffff-000000000001',
};

let hcaptchaWidgetId = null;

function renderCaptcha(region) {
  if (typeof hcaptcha === 'undefined') return;
  const el = document.getElementById('hcaptcha-widget');
  el.innerHTML = '';
  hcaptchaWidgetId = hcaptcha.render(el, {
    sitekey: HCAPTCHA_KEYS[region] || HCAPTCHA_KEYS.eu,
    theme: 'dark',
    callback: token => { document.getElementById('login-captcha').value = token; },
    'expired-callback': () => { document.getElementById('login-captcha').value = ''; },
  });
}

// Re-render widget when region changes
window.addEventListener('DOMContentLoaded', () => {
  const regionSel = document.getElementById('login-region');
  if (regionSel) {
    regionSel.addEventListener('change', () => renderCaptcha(regionSel.value));
  }
});

// Called by hCaptcha JS SDK once loaded
window.onloadCallback = () => {
  const region = (document.getElementById('login-region') || {}).value || 'eu';
  renderCaptcha(region);
};

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  vehicles: [],
  selectedVin: null,
  vehicleState: null,
  chargingData: null,
  lastTrip: null,
  alltimeStats: null,
  chargingSessions: [],
  map: null,
  mapMarker: null,
  gaugeChart: null,
  sessionsChart: null,
  refreshTimer: null,
};

// ── Helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = (v, fallback = '–') => (v != null && v !== undefined) ? v : fallback;

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || r.statusText);
  }
  return r.json();
}

function setHTML(id, html) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function formatDuration(minutes) {
  if (!minutes) return '–';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}min` : `${m}min`;
}

function formatDate(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function getBatteryColor(pct) {
  if (pct >= 60) return '#2ecc71';
  if (pct >= 20) return '#f39c12';
  return '#e74c3c';
}

// ── Login ──────────────────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  const errEl = $('login-error');
  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Verbinde…';

  try {
    const captcha = $('login-captcha').value.trim();
    if (!captcha) {
      errEl.textContent = 'Bitte zuerst das Captcha (Checkbox oben) bestätigen.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Anmelden';
      return;
    }
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        email: $('login-email').value.trim(),
        password: $('login-password').value,
        region: $('login-region').value,
        captcha_token: captcha,
      }),
    });
    await initDashboard();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  clearInterval(state.refreshTimer);
  $('dashboard').style.display = 'none';
  $('login-screen').style.display = 'flex';
  $('login-btn').disabled = false;
  $('login-btn').textContent = 'Anmelden';
});

$('refresh-btn').addEventListener('click', () => refreshAll());

// ── Init ───────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const status = await api('/api/status');
    if (status.authenticated) {
      await initDashboard();
    }
  } catch {}
}

async function initDashboard() {
  $('login-screen').style.display = 'none';
  $('dashboard').style.display = 'block';

  initMap();
  initGauge();
  initSessionsChart();

  await loadVehicles();
  await refreshAll();

  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refreshAll, 5 * 60 * 1000);
}

// ── Vehicles ───────────────────────────────────────────────────────────────
async function loadVehicles() {
  const data = await api('/api/vehicles');
  // API returns array or object with vehicles array
  state.vehicles = Array.isArray(data) ? data : (data.vehicles || [data]);

  const sel = $('vehicle-selector');
  sel.innerHTML = '';
  state.vehicles.forEach((v, i) => {
    const label = `${v.attributes?.model || v.model || 'BMW'} (${(v.vin || '').slice(-8)})`;
    sel.innerHTML += `<option value="${v.vin}" ${i === 0 ? 'selected' : ''}>${label}</option>`;
  });

  if (state.vehicles.length > 1) sel.style.display = '';
  state.selectedVin = state.vehicles[0]?.vin;

  sel.addEventListener('change', () => {
    state.selectedVin = sel.value;
    refreshAll();
  });

  renderVehicleHeader(state.vehicles[0]);
}

function renderVehicleHeader(v) {
  if (!v) return;
  const attrs = v.attributes || v;
  setText('v-model', attrs.model || attrs.modelName || 'BMW');
  setText('v-vin', `VIN: ${v.vin || '–'}`);
  setText('v-year', attrs.year || attrs.modelYear || '–');
  setText('v-fuel', attrs.driveTrain || 'Elektrisch');
}

// ── Refresh all data ───────────────────────────────────────────────────────
async function refreshAll() {
  if (!state.selectedVin) return;
  const icon = $('refresh-icon');
  icon.classList.add('spin');

  try {
    const [vstate, charging, lastTrip, alltime, sessions] = await Promise.allSettled([
      api(`/api/state/${state.selectedVin}`),
      api(`/api/charging/${state.selectedVin}`),
      api('/api/lasttrip'),
      api('/api/alltime'),
      api('/api/sessions'),
    ]);

    if (vstate.status === 'fulfilled') {
      state.vehicleState = vstate.value;
      renderVehicleState(vstate.value);
    }
    if (charging.status === 'fulfilled') {
      state.chargingData = charging.value;
      renderCharging(charging.value);
    }
    if (lastTrip.status === 'fulfilled') {
      state.lastTrip = lastTrip.value;
      renderLastTrip(lastTrip.value);
    }
    if (alltime.status === 'fulfilled') {
      state.alltimeStats = alltime.value;
      renderAlltimeStats(alltime.value);
    }
    if (sessions.status === 'fulfilled') {
      state.chargingSessions = sessions.value;
      renderSessionsChart(sessions.value);
    }

    const now = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    setText('last-updated', `Aktualisiert: ${now}`);
  } catch (err) {
    console.error('Refresh failed', err);
  } finally {
    icon.classList.remove('spin');
  }
}

// ── Vehicle State ──────────────────────────────────────────────────────────
function renderVehicleState(data) {
  const s = data.state || data;

  // Mileage
  const mileage = s.currentMileage || s.mileage || s.odometer?.mileage;
  setText('v-mileage', mileage ? mileage.toLocaleString('de-DE') : '–');

  // Electric charging state
  const elec = s.electricChargingState || s.chargingState || {};
  const pct = elec.chargingLevelPercent ?? elec.batteryChargingState?.chargeLevelPercent ?? null;
  const range = elec.range ?? elec.remainingRange ?? s.range?.electricalRange;

  setText('v-range', range ?? '–');

  // Vehicle status badge
  const isReady = s.isLeftSteering !== undefined || pct !== null;
  $('v-status').textContent = isReady ? 'Verbunden' : 'Offline';
  $('v-status').className = 'badge ' + (isReady ? 'green' : '');

  // Battery gauge
  if (pct !== null) {
    updateGauge(pct, range);
    setText('g-pct', pct);
    setText('g-range', `${range ?? '–'} km`);
    const chargingStatus = elec.chargingStatus || elec.status || '';
    setText('g-status-text', translateStatus(chargingStatus));
    setText('g-target', (elec.chargingTarget ?? elec.chargeLevelTarget ?? 80));
  }

  // Doors
  const doors = s.doorsState || s.doors || {};
  const windows = s.windowsState || s.windows || {};
  renderDoors(doors, windows);

  // Location
  const loc = s.location || s.gpsCoordinates;
  if (loc) {
    const lat = loc.coordinates?.latitude ?? loc.latitude;
    const lon = loc.coordinates?.longitude ?? loc.longitude;
    const address = loc.address?.formatted ?? loc.formattedAddress;
    if (lat && lon) updateMap(lat, lon, address);
  }

  // Service
  const svc = s.requiredServices || s.serviceMessages || s.checkControlMessages || [];
  renderService(s, svc);
}

function translateStatus(status) {
  const map = {
    STANDBY: 'Bereit',
    CHARGING: 'Lädt',
    COMPLETE: 'Voll',
    ERROR: 'Fehler',
    FULLY_CHARGED: 'Voll',
    WAITING_FOR_CHARGING: 'Warte…',
    NOT_CHARGING: 'Nicht geladen',
  };
  return map[status] || status || '–';
}

// ── Battery Gauge ──────────────────────────────────────────────────────────
function initGauge() {
  const ctx = $('gauge-battery').getContext('2d');
  state.gaugeChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [0, 100],
        backgroundColor: ['#2ecc71', '#1c2b3e'],
        borderWidth: 0,
        circumference: 270,
        rotation: 225,
      }]
    },
    options: {
      cutout: '78%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 600 },
    }
  });
}

function updateGauge(pct, range) {
  if (!state.gaugeChart) return;
  const color = getBatteryColor(pct);
  const ds = state.gaugeChart.data.datasets[0];
  ds.data = [pct, 100 - pct];
  ds.backgroundColor = [color, '#1c2b3e'];
  state.gaugeChart.update();
  $('g-pct').style.color = color;
}

// ── Charging ───────────────────────────────────────────────────────────────
function renderCharging(data) {
  const c = data.chargingState || data.state || data;
  const isPlugged = c.isChargerConnected ?? c.pluggedIn ?? false;
  const status = c.chargingStatus || c.status || '';
  const isCharging = status === 'CHARGING' || status === 'FAST_CHARGING';

  const icon = $('plug-icon');
  icon.className = 'charge-plug-icon ' + (isPlugged ? 'plugged' : 'unplugged');
  icon.textContent = isPlugged ? '⚡' : '🔌';

  setText('charge-status-text', isCharging ? 'Wird geladen' : (isPlugged ? 'Stecker verbunden' : 'Nicht verbunden'));

  const pct = c.chargingLevelPercent ?? c.batteryChargingState?.chargeLevelPercent ?? 0;
  $('charge-bar').style.width = `${pct}%`;

  const chargingType = c.chargingConnectionType || c.connectionType || '–';
  setText('c-type', translateChargingType(chargingType));

  const power = c.chargingRateInKilometersPerHour != null
    ? `${(c.chargingRateInKilometersPerHour / 6).toFixed(1)} kW`
    : (c.chargingPower != null ? `${c.chargingPower} kW` : '–');
  setText('c-power', power);

  const remaining = c.remainingChargingMinutes ?? c.timeToFullCharge;
  setText('c-remaining', remaining != null ? formatDuration(remaining) : '–');

  const target = c.chargingTarget ?? c.chargeLevelTarget;
  setText('c-target', target != null ? `${target}%` : '–');
}

function translateChargingType(type) {
  const map = { AC: 'AC (Wechselstrom)', DC: 'DC (Gleichstrom)', FAST: 'DC Schnell', NONE: '–' };
  return map[type] || type || '–';
}

// ── Doors ─────────────────────────────────────────────────────────────────
function renderDoors(doors, windows) {
  const items = [
    { key: 'leftFront',  label: 'VL Tür',       icon: '🚗' },
    { key: 'rightFront', label: 'VR Tür',       icon: '🚗' },
    { key: 'leftRear',   label: 'HL Tür',       icon: '🚗' },
    { key: 'rightRear',  label: 'HR Tür',       icon: '🚗' },
    { key: 'hood',       label: 'Motorhaube',   icon: '🔧' },
    { key: 'trunk',      label: 'Kofferraum',   icon: '📦' },
  ];

  const grid = $('doors-grid');
  grid.innerHTML = items.map(({ key, label, icon }) => {
    const rawVal = doors[key] || doors[key.replace(/([A-Z])/g, '_$1').toLowerCase()];
    const isOpen = rawVal && rawVal !== 'CLOSED' && rawVal !== 'LOCKED';
    const cls = isOpen ? 'open' : 'closed';
    const statusText = isOpen ? 'Offen' : 'Geschlossen';
    return `
      <div class="door-item ${cls}">
        <div class="door-icon">${icon}</div>
        <div class="door-name">${label}</div>
        <div class="door-status">${statusText}</div>
      </div>`;
  }).join('');
}

// ── Map ────────────────────────────────────────────────────────────────────
function initMap() {
  if (state.map) return;
  state.map = L.map('map', { zoomControl: true }).setView([48.137, 11.576], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(state.map);
}

function updateMap(lat, lon, address) {
  if (!state.map) return;
  state.map.setView([lat, lon], 15);

  if (state.mapMarker) state.mapMarker.remove();

  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:36px;height:36px;border-radius:50%;
      background:#0166b1;border:3px solid white;
      box-shadow:0 2px 8px rgba(0,0,0,0.4);
      display:flex;align-items:center;justify-content:center;
      font-size:18px;cursor:pointer;
    ">🚗</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });

  state.mapMarker = L.marker([lat, lon], { icon }).addTo(state.map);

  if (address) {
    setText('map-address', address);
    state.mapMarker.bindPopup(address);
  } else {
    // Reverse geocode via Nominatim
    fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`)
      .then(r => r.json())
      .then(d => {
        const addr = d.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        setText('map-address', addr);
        state.mapMarker.bindPopup(addr);
      })
      .catch(() => setText('map-address', `${lat.toFixed(5)}, ${lon.toFixed(5)}`));
  }
}

// ── Last trip ──────────────────────────────────────────────────────────────
function renderLastTrip(data) {
  const t = data.lastTrip || data.trip || data;
  const dist = t.totalDistance ?? t.distance ?? t.tripDistance;
  const dur = t.totalDuration ?? t.duration ?? t.tripDuration;
  const cons = t.totalEnergyConsumption ?? t.electricConsumption ?? t.averageElectricConsumption;
  const reco = t.totalRecuperatedEnergy ?? t.recuperatedEnergy;

  setText('t-dist', dist != null ? (dist / 1000).toFixed(1) : '–');
  setText('t-dur', dur != null ? Math.round(dur / 60) : '–');
  setText('t-cons', cons != null ? cons.toFixed(1) : '–');
  setText('t-reco', reco != null ? reco.toFixed(1) : '–');
}

// ── All-time Stats ─────────────────────────────────────────────────────────
function renderAlltimeStats(data) {
  const s = data.statistics || data.alltime || data;
  const items = [
    { icon: '🛣️', value: fmt(s.totalDistance != null ? (s.totalDistance / 1000).toFixed(0) : null), unit: 'km', label: 'Gesamtstrecke' },
    { icon: '⚡', value: fmt(s.totalElectricDistance != null ? (s.totalElectricDistance / 1000).toFixed(0) : null), unit: 'km', label: 'Elektrisch gefahren' },
    { icon: '🔋', value: fmt(s.totalEnergyCharged != null ? s.totalEnergyCharged.toFixed(0) : null), unit: 'kWh', label: 'Geladen gesamt' },
    { icon: '♻️', value: fmt(s.totalRecuperatedEnergy != null ? s.totalRecuperatedEnergy.toFixed(0) : null), unit: 'kWh', label: 'Rekuperiert gesamt' },
  ];

  $('alltime-grid').innerHTML = items.map(i => `
    <div class="alltime-box">
      <div class="at-icon">${i.icon}</div>
      <div><span class="at-value">${i.value}</span><span class="at-unit">${i.unit}</span></div>
      <div class="at-label">${i.label}</div>
    </div>
  `).join('');
}

// ── Service ────────────────────────────────────────────────────────────────
function renderService(vehicleState, svcMessages) {
  const rows = [];

  // Condition Based Services
  const cbs = vehicleState.conditionBasedServices || vehicleState.cbsData || [];
  cbs.forEach(item => {
    const isOk = item.state === 'OK' || item.status === 'OK';
    const cls = isOk ? 'ok' : 'warn';
    const due = item.dueDate ? formatDate(item.dueDate) : (item.remainingMileage ? `${item.remainingMileage} km` : '–');
    rows.push({ label: item.description || item.cbsType || 'Service', value: due, cls });
  });

  // Tires
  const tires = vehicleState.tireState || vehicleState.tires;
  if (tires) {
    const tirePressure = tires.frontLeft?.currentPressure || tires.pressure;
    if (tirePressure) {
      rows.push({ label: 'Reifendruck', value: `${tirePressure} bar`, cls: 'ok' });
    }
  }

  // Check control messages
  svcMessages.forEach(m => {
    const isAlert = m.state === 'CRITICAL' || m.severity === 'CRITICAL';
    rows.push({ label: m.description || m.type, value: m.state || '!', cls: isAlert ? 'alert' : 'warn' });
  });

  if (rows.length === 0) {
    rows.push({ label: 'Kein Service erforderlich', value: 'OK', cls: 'ok' });
  }

  $('service-rows').innerHTML = rows.map(r => `
    <div class="service-row">
      <span class="svc-label">${r.label}</span>
      <span class="svc-value ${r.cls}">${r.value}</span>
    </div>
  `).join('');
}

// ── Charging Sessions Chart ────────────────────────────────────────────────
function initSessionsChart() {
  const ctx = $('chart-sessions').getContext('2d');
  state.sessionsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Geladen (kWh)',
        data: [],
        backgroundColor: 'rgba(1, 102, 177, 0.6)',
        borderColor: '#0166b1',
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2b3e',
          titleColor: '#7a90a8',
          bodyColor: '#e8edf2',
          borderColor: '#243548',
          borderWidth: 1,
          callbacks: {
            label: ctx => `${ctx.parsed.y.toFixed(1)} kWh`,
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#7a90a8', font: { size: 11 } },
          grid: { color: '#243548' },
        },
        y: {
          ticks: { color: '#7a90a8', font: { size: 11 }, callback: v => `${v} kWh` },
          grid: { color: '#243548' },
          beginAtZero: true,
        }
      }
    }
  });
}

function renderSessionsChart(data) {
  const sessions = Array.isArray(data) ? data : (data.chargingSessions || data.sessions || []);
  const last10 = sessions.slice(-10);

  if (last10.length === 0) {
    $('card-sessions').style.display = 'none';
    return;
  }

  const labels = last10.map(s => {
    const date = s.date || s.startTime || s.timestamp;
    return date ? new Date(date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '–';
  });

  const values = last10.map(s =>
    s.energyCharged ?? s.energy ?? s.totalEnergyCharged ?? 0
  );

  state.sessionsChart.data.labels = labels;
  state.sessionsChart.data.datasets[0].data = values;
  state.sessionsChart.update();
}

// ── Start ──────────────────────────────────────────────────────────────────
boot();
