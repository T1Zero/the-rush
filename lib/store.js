// Storage abstraction with two interchangeable drivers.
//   • Local / your PC  → JSON file (zero dependencies, fully testable)
//   • Vercel / cloud   → Upstash Redis (set UPSTASH_REDIS_REST_URL + _TOKEN)
// The driver is chosen automatically by whether the Upstash env vars exist,
// so the exact same app code runs in both places.
const fs = require('fs');
const path = require('path');

const useUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

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
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
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

const store = useUpstash ? upstashStore() : fileStore();
store.driver = useUpstash ? 'upstash' : 'file';
module.exports = store;
