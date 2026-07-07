// Storage abstraction with two interchangeable drivers.
//   • Local / your PC  → JSON file (zero dependencies, fully testable)
//   • Vercel / cloud   → Upstash Redis (REST URL + token)
// The driver is chosen automatically by whether the Redis env vars exist,
// so the exact same app code runs in both places. We accept both the Upstash
// naming (UPSTASH_REDIS_REST_*) and the Vercel Marketplace naming (KV_REST_API_*).
const fs = require('fs');
const path = require('path');

const useTurso = !!(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const useUpstash = !useTurso && !!(REDIS_URL && REDIS_TOKEN);

/* ---------------- File driver (local dev) ---------------- */
function fileStore() {
  const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data.json');
  let mem = { users: {}, sessions: {}, ips: {}, cache: {} };
  try { mem = Object.assign(mem, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch {}
  mem.users = mem.users || {}; mem.sessions = mem.sessions || {};
  mem.ips = mem.ips || {}; mem.cache = mem.cache || {};

  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fs.writeFile(DATA_FILE, JSON.stringify(mem, null, 2), () => {}), 200);
  };

  return {
    async getUser(email) { return mem.users[email] || null; },
    async saveUser(user) { mem.users[user.email] = user; flush(); },
    async allUsers() { return Object.values(mem.users); },
    async getToken(token) { return mem.sessions[token] || null; },
    async putToken(token, email) { mem.sessions[token] = email; flush(); },
    async getIp(ip) { return mem.ips[ip] || null; },
    async putIp(ip, email) { mem.ips[ip] = email; flush(); },
    async getCache(key) {
      const c = mem.cache[key];
      if (!c) return null;
      if (c.exp && c.exp < Date.now()) { delete mem.cache[key]; return null; }
      return c.v;
    },
    async setCache(key, v, ttlSec) { mem.cache[key] = { v, exp: Date.now() + ttlSec * 1000 }; flush(); },
  };
}

/* ---------------- Upstash driver (production) ---------------- */
function upstashStore() {
  const { Redis } = require('@upstash/redis'); // only required when actually used
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  return {
    async getUser(email) { return (await redis.hget('users', email)) || null; },
    async saveUser(user) { await redis.hset('users', { [user.email]: user }); },
    async allUsers() { const all = await redis.hgetall('users'); return all ? Object.values(all) : []; },
    async getToken(token) { return (await redis.hget('sessions', token)) || null; },
    async putToken(token, email) { await redis.hset('sessions', { [token]: email }); },
    async getIp(ip) { return (await redis.hget('ips', ip)) || null; },
    async putIp(ip, email) { await redis.hset('ips', { [ip]: email }); },
    async getCache(key) { return (await redis.get(key)) ?? null; },
    async setCache(key, v, ttlSec) { await redis.set(key, v, { ex: ttlSec }); },
  };
}

/* ---------------- Turso driver (production, huge free tier) ---------------- */
function tursoStore() {
  const { createClient } = require('@libsql/client/web'); // fetch-based, serverless-friendly
  let url = process.env.TURSO_DATABASE_URL;
  if (url.startsWith('libsql://')) url = 'https://' + url.slice('libsql://'.length);
  const db = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  let ready = null;
  const init = () => ready || (ready = db.execute('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'));
  const get = async (k) => { await init(); const r = await db.execute({ sql: 'SELECT v FROM kv WHERE k=?', args: [k] }); return r.rows.length ? r.rows[0].v : null; };
  const set = async (k, v) => { await init(); await db.execute({ sql: 'INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', args: [k, v] }); };
  return {
    async getUser(email) { const v = await get('user:' + email); return v ? JSON.parse(v) : null; },
    async saveUser(user) { await set('user:' + user.email, JSON.stringify(user)); },
    async allUsers() { await init(); const r = await db.execute("SELECT v FROM kv WHERE k LIKE 'user:%'"); return r.rows.map(row => JSON.parse(row.v)); },
    async getToken(token) { return await get('session:' + token); },
    async putToken(token, email) { await set('session:' + token, email); },
    async getIp(ip) { return await get('ip:' + ip); },
    async putIp(ip, email) { await set('ip:' + ip, email); },
    async getCache(key) { const v = await get('cache:' + key); if (!v) return null; const o = JSON.parse(v); if (o.exp && o.exp < Date.now()) return null; return o.v; },
    async setCache(key, v, ttlSec) { await set('cache:' + key, JSON.stringify({ v, exp: Date.now() + ttlSec * 1000 })); },
  };
}

const store = useTurso ? tursoStore() : useUpstash ? upstashStore() : fileStore();
store.driver = useTurso ? 'turso' : useUpstash ? 'upstash' : 'file';
module.exports = store;
