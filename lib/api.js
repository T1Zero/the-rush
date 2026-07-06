// Shared API router — used by both the local Node server and the Vercel function.
const crypto = require('crypto');
const L = require('./logic');
const market = require('./market');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body); // Vercel may pre-parse
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function clientIp(req) {
  if (L.TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip']; // Cloudflare tunnel / proxy: true visitor IP
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || '';
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// naive per-instance login throttle (best-effort on serverless)
const loginFails = new Map();
function loginBlocked(ip) { const r = loginFails.get(ip); return r && r.until > Date.now(); }
function noteFail(ip) {
  const r = loginFails.get(ip) || { count: 0, until: 0 };
  r.count++;
  if (r.count >= 8) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; }
  loginFails.set(ip, r);
}

async function authUser(req, store) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const email = await store.getToken(token);
  return email ? await store.getUser(email) : null;
}

async function issueToken(store, email) {
  const token = crypto.randomBytes(24).toString('hex');
  await store.putToken(token, email);
  return token;
}

async function handleApi(req, res, store) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname.replace(/\/$/, '')}`;

  try {
    if (route === 'POST /api/register') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const ip = clientIp(req);
      if (!name || name.length > 40) return sendJson(res, 400, { error: 'Enter a display name (max 40 chars).' });
      if (!validEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email.' });
      if (password.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
      if (await store.getUser(email)) return sendJson(res, 400, { error: 'An account with that email already exists.' });
      if (L.ONE_ACCOUNT_PER_IP && email !== L.ADMIN_EMAIL && ip) {
        const existing = await store.getIp(ip);
        if (existing && existing !== L.ADMIN_EMAIL) {
          return sendJson(res, 400, { error: 'An account has already been registered from this device/network. One account per person.' });
        }
      }
      const user = L.newUser(name, email, password, ip);
      await store.saveUser(user);
      if (ip && email !== L.ADMIN_EMAIL) await store.putIp(ip, email);
      const token = await issueToken(store, email);
      return sendJson(res, 200, { ok: true, token });
    }

    if (route === 'POST /api/login') {
      const b = await readBody(req);
      const ip = clientIp(req);
      if (loginBlocked(ip)) return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
      const email = String(b.email || '').trim().toLowerCase();
      const user = await store.getUser(email);
      if (!user || !L.safeEqual(user.hash, L.hashPassword(String(b.password || ''), user.salt))) {
        noteFail(ip);
        return sendJson(res, 401, { error: 'Invalid email or password.' });
      }
      const token = await issueToken(store, email);
      return sendJson(res, 200, { ok: true, token });
    }

    if (route === 'GET /api/candles') {
      const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
      const tf = String(url.searchParams.get('tf') || '1m');
      const spec = L.SPECS[symbol];
      if (!spec) return sendJson(res, 400, { error: 'Unknown symbol.' });
      if (!market.TF_MAP[tf]) return sendJson(res, 400, { error: 'Bad timeframe.' });
      try {
        const candles = await market.getCandles(store, spec.feed, tf);
        return sendJson(res, 200, { symbol, tf, candles });
      } catch (e) {
        return sendJson(res, 502, { error: 'Data source error — try again.' });
      }
    }

    if (route === 'GET /api/state') {
      const user = await authUser(req, store);
      if (!user) return sendJson(res, 401, { error: 'Not logged in.' });
      const { bySym, view } = market.views(await market.ensureQuotes(store));
      if (L.enforceRisk(user, bySym)) await store.saveUser(user);
      const payload = { account: L.accountView(user, bySym), quotes: view };
      if (user.email === L.ADMIN_EMAIL) payload.leaderboard = L.leaderboard(await store.allUsers(), bySym);
      return sendJson(res, 200, payload);
    }

    if (route === 'POST /api/order') {
      const user = await authUser(req, store);
      if (!user) return sendJson(res, 401, { error: 'Not logged in.' });
      const b = await readBody(req);
      const { bySym } = market.views(await market.ensureQuotes(store));
      const r = L.placeOrder(user, bySym, String(b.symbol || '').toUpperCase(), String(b.side || '').toLowerCase(), b.qty);
      await store.saveUser(user);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    if (route === 'POST /api/flatten') {
      const user = await authUser(req, store);
      if (!user) return sendJson(res, 401, { error: 'Not logged in.' });
      const { bySym } = market.views(await market.ensureQuotes(store));
      L.flattenAll(user, bySym, 'manual flatten');
      L.enforceRisk(user, bySym);
      await store.saveUser(user);
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'POST /api/admin/reset') {
      const user = await authUser(req, store);
      if (!user || user.email !== L.ADMIN_EMAIL) return sendJson(res, 403, { error: 'Admin only.' });
      const b = await readBody(req);
      if (!b.confirm) return sendJson(res, 400, { error: 'Pass { confirm: true } to run the reset.' });
      const below = typeof b.below === 'number' ? b.below : L.START_BALANCE; // reset accounts under this balance
      const all = await store.allUsers();
      const reset = [];
      for (const u of all) {
        if (u.balance < below) {
          reset.push({ name: u.name, was: Math.round(u.balance) });
          L.resetAccount(u);
          await store.saveUser(u);
        }
      }
      return sendJson(res, 200, { ok: true, below, count: reset.length, reset });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: 'Server error' });
  }
}

module.exports = { handleApi };
