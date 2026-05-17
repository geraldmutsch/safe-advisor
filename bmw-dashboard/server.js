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

async function authenticateBMW(email, password, region = 'eu') {
  const config = REGIONS[region] || REGIONS.eu;
  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = `https://${config.authHost}/gcdm/oauth/authenticate`;
  const tokenUrl = `https://${config.authHost}/gcdm/oauth/token`;

  // Step 1: POST credentials to get authorization code
  let code;
  try {
    const authResp = await axios.post(
      authUrl,
      new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        scope: SCOPE,
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        username: email,
        password: password,
        grant_type: 'authorization_code'
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-User-Agent': 'android(v1.7.0);bmw;1.7.0;row',
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36'
        },
        maxRedirects: 5,
        validateStatus: s => s < 500
      }
    );

    // Extract code from redirect Location header or response body
    const location = authResp.headers?.location || authResp.request?.res?.responseUrl || '';
    if (location) {
      try {
        const u = new URL(location.startsWith('com.bmw') ? location.replace('com.bmw.connected://', 'https://placeholder/') : location);
        code = u.searchParams.get('code');
      } catch {}
    }
    if (!code && authResp.data?.code) code = authResp.data.code;
    if (!code && authResp.data?.redirect_to) {
      const u = new URL(authResp.data.redirect_to.replace('com.bmw.connected://', 'https://placeholder/'));
      code = u.searchParams.get('code');
    }
  } catch (err) {
    throw new Error(`Verbindung zu BMW fehlgeschlagen: ${err.message}`);
  }

  if (!code) {
    throw new Error('Anmeldung fehlgeschlagen: Ungültige E-Mail oder Passwort. Bitte BMW ConnectedDrive-Zugangsdaten prüfen.');
  }

  // Step 2: Exchange code for tokens
  const tokenResp = await axios.post(
    tokenUrl,
    new URLSearchParams({
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-User-Agent': 'android(v1.7.0);bmw;1.7.0;row'
      }
    }
  );

  if (!tokenResp.data?.access_token) {
    throw new Error('Token-Austausch fehlgeschlagen');
  }
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
