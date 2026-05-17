const express = require('express');
const axios = require('axios');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const REGIONS = {
  eu:  { authHost: 'customer.bmwgroup.com',  apiHost: 'cocoapi.bmwgroup.com',  countryId: 'DE', languageId: 'de' },
  us:  { authHost: 'login.bmwusa.com',        apiHost: 'cocoapi.bmwgroup.com',  countryId: 'US', languageId: 'en' },
  cn:  { authHost: 'login.bmw.com.cn',        apiHost: 'cocoapi.bmwgroup.cn',   countryId: 'CN', languageId: 'zh' },
  row: { authHost: 'customer.bmwgroup.com',  apiHost: 'cocoapi.bmwgroup.com',  countryId: 'AU', languageId: 'en' }
};

// BMW ConnectedDrive OAuth2 client credentials (from bimmer_connected open-source project)
const CLIENT_ID = 'dbf0a542-ebd1-4ff0-a9a7-55172fbfce35';
const CLIENT_SECRET = '7f359ece-b4eb-42e7-8522-be2bc5060f57';
const REDIRECT_URI = 'com.bmw.connected://oauth';
const SCOPE = 'openid profile email offline_access smacc vehicle_data perseus dlm tsc svds remote_services fupo';

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function extractCode(location) {
  if (!location) return null;
  try {
    const url = new URL(location.replace('com.bmw.connected://oauth', 'https://x/oauth'));
    return url.searchParams.get('code') || null;
  } catch {
    const m = location.match(/[?&]code=([^&]+)/);
    return m ? m[1] : null;
  }
}

async function authenticateBMW(email, password, region = 'eu') {
  const config = REGIONS[region] || REGIONS.eu;
  const { verifier, challenge } = generatePKCE();
  const oauthState = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  const authBase = `https://${config.authHost}`;
  const tokenUrl = `${authBase}/gcdm/oauth/token`;

  const commonParams = {
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state: oauthState,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };

  const headers = {
    'X-User-Agent': 'android(v1.7.0);bmw;1.7.0;row',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 12; sdk_gphone64_arm64)',
  };

  // Step 1: GET login page to obtain session cookies
  let cookies = '';
  try {
    const initResp = await axios.get(`${authBase}/gcdm/oauth/authenticate`, {
      params: commonParams,
      headers,
      maxRedirects: 0,
      validateStatus: s => s < 500,
    });
    const setCookie = initResp.headers['set-cookie'];
    if (setCookie) cookies = setCookie.map(c => c.split(';')[0]).join('; ');
  } catch (err) {
    throw new Error(`BMW nicht erreichbar: ${err.message}`);
  }

  // Step 2: POST credentials
  let code;
  try {
    const authResp = await axios.post(
      `${authBase}/gcdm/oauth/authenticate`,
      new URLSearchParams({ ...commonParams, username: email, password, grant_type: 'authorization_code' }).toString(),
      {
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(cookies ? { Cookie: cookies } : {}),
        },
        maxRedirects: 0,
        validateStatus: s => s < 500,
      }
    );

    // Code may appear in Location header (redirect) or response body
    code = extractCode(authResp.headers?.location)
        || extractCode(authResp.data?.redirect_to)
        || authResp.data?.code
        || null;

    // If redirect was followed, try final URL
    if (!code && authResp.request?.res?.responseUrl) {
      code = extractCode(authResp.request.res.responseUrl);
    }

    if (!code && (authResp.status === 401 || authResp.data?.error)) {
      const detail = authResp.data?.error_description || authResp.data?.error || '';
      throw new Error(`Zugangsdaten falsch${detail ? ': ' + detail : ''}. Bitte mit myBMW-App-Login prüfen.`);
    }
  } catch (err) {
    if (err.message.includes('Zugangsdaten')) throw err;
    throw new Error(`Verbindung fehlgeschlagen: ${err.message}`);
  }

  if (!code) {
    throw new Error('Anmeldung fehlgeschlagen. Tipp: Stellen Sie sicher, dass Sie die myBMW App-Zugangsdaten (nicht ConnectedDrive Classic) verwenden.');
  }

  // Step 3: Exchange code for tokens
  const tokenResp = await axios.post(
    tokenUrl,
    new URLSearchParams({
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
    { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (!tokenResp.data?.access_token) throw new Error('Token-Austausch fehlgeschlagen');
  return tokenResp.data;
}

async function refreshBMWToken(refreshToken, region = 'eu') {
  const config = REGIONS[region] || REGIONS.eu;
  const tokenUrl = `https://${config.authHost}/gcdm/oauth/token`;
  const resp = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return resp.data;
}

async function bmwApi(sess, endpoint, method = 'GET', body = null) {
  const config = REGIONS[sess.region] || REGIONS.eu;
  const resp = await axios({
    method,
    url: `https://${config.apiHost}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${sess.accessToken}`,
      'X-User-Agent': 'android(v1.7.0);bmw;1.7.0;row',
      'X-Country-Id': config.countryId,
      'X-Language-Id': config.languageId,
      'Content-Type': 'application/json'
    },
    data: body
  });
  return resp.data;
}

function requireAuth(req, res, next) {
  if (!req.session.accessToken) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}

// Retry with token refresh on 401
async function apiWithRefresh(req, res, endpoint) {
  try {
    return await bmwApi(req.session, endpoint);
  } catch (err) {
    if (err.response?.status === 401 && req.session.refreshToken) {
      try {
        const tokens = await refreshBMWToken(req.session.refreshToken, req.session.region);
        req.session.accessToken = tokens.access_token;
        if (tokens.refresh_token) req.session.refreshToken = tokens.refresh_token;
        return await bmwApi(req.session, endpoint);
      } catch {
        throw new Error('Session abgelaufen, bitte neu anmelden');
      }
    }
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!req.session.accessToken });
});

app.post('/api/login', async (req, res) => {
  const { email, password, region } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-Mail und Passwort erforderlich' });
  try {
    const tokens = await authenticateBMW(email, password, region || 'eu');
    req.session.accessToken = tokens.access_token;
    req.session.refreshToken = tokens.refresh_token;
    req.session.region = region || 'eu';
    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/vehicles', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, '/eadrax-vcs/v4/vehicles');
    res.json(data);
  } catch (err) {
    const status = err.message.includes('Session') ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

app.get('/api/state/:vin', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, `/eadrax-vcs/v4/vehicles/${req.params.vin}/state`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/charging/:vin', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, `/eadrax-crccs/v1/charging/${req.params.vin}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, '/eadrax-crccs/v1/charging/sessions');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/lasttrip', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, '/eadrax-dcs/v1/statistics/last-trip');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alltime', requireAuth, async (req, res) => {
  try {
    const data = await apiWithRefresh(req, res, '/eadrax-dcs/v1/statistics/alltime');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  BMW Dashboard ▸  http://localhost:${PORT}\n`);
});
