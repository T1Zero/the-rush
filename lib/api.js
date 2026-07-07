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

function genPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let p = '';
  for (let i = 0; i < 10; i++) p += cs[bytes[i] % cs.length];
  return p;
}

// naive per-instance login throttle (best-effort on serverless)
const loginFails = new Map();
function loginBlocked(ip) { const r = loginFails.get(ip); return r && r.until > Date.now(); }
function noteFail(ip) {
  const r = loginFails.get(ip) || { count: 0, until: 0 };
  r.count++;
  if (r.count >= 8) { r.until = Date.now() + 15 * 60 * 1000; r.count = 0; }
  loginFails.set(ip, r);
}

// Warm session cache (token -> email) so repeat requests skip the getToken read.
const sessionMem = new Map();
async function authUser(req, store) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  let email;
  const m = sessionMem.get(token);
  if (m && Date.now() - m.t < 60000) email = m.email;
  else {
    email = await store.getToken(token);
    if (email) sessionMem.set(token, { email, t: Date.now() });
  }
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

    if (route === 'GET /api/admin/user') {
      const admin = await authUser(req, store);
      if (!admin || admin.email !== L.ADMIN_EMAIL) return sendJson(res, 403, { error: 'Admin only.' });
      const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
      const u = await store.getUser(email);
      if (!u) return sendJson(res, 404, { error: 'No account with that email.' });
      const { bySym } = market.views(await market.ensureQuotes(store));
      const unrl = L.unrealized(u, bySym);
      const equity = u.balance + unrl;
      const positions = Object.entries(u.positions).filter(([, p]) => p.qty !== 0).map(([sym, p]) => {
        const last = bySym[sym] ?? null;
        return { symbol: sym, qty: p.qty, avg: p.avg, last, upnl: last == null ? 0 : L.round2((last - p.avg) * p.qty * L.SPECS[sym].pointValue) };
      });
      return sendJson(res, 200, {
        name: u.name, email: u.email, ip: u.ip || '', created: u.created,
        balance: L.round2(u.balance), equity: L.round2(equity), pnl: L.round2(equity - L.START_BALANCE),
        blown: u.blown, dailyLocked: u.dailyLocked,
        positions, trades: u.trades.slice().reverse(),
      });
    }

    if (route === 'POST /api/admin/set-password') {
      const user = await authUser(req, store);
      if (!user || user.email !== L.ADMIN_EMAIL) return sendJson(res, 403, { error: 'Admin only.' });
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const target = await store.getUser(email);
      if (!target) return sendJson(res, 404, { error: 'No account with that email.' });
      const custom = String(b.password || '').trim();
      if (custom && custom.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters.' });
      const newPass = custom || genPassword();
      target.salt = crypto.randomBytes(16).toString('hex');
      target.hash = L.hashPassword(newPass, target.salt);
      await store.saveUser(target);
      return sendJson(res, 200, { ok: true, email: target.email, name: target.name, password: newPass });
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return sendJson(res, 500, { error: 'Server error' });
  }
}

module.exports = { handleApi };
