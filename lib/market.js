// Market data — fetched on demand from Yahoo Finance and cached in the store,
// so it works on serverless (no background loop needed).
const { SPECS, round2 } = require('./logic');

const FEEDS = ['^GSPC', '^NDX'];
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

const TF_MAP = {
  '1m':  { interval: '1m',  range: '2d'  },
  '5m':  { interval: '5m',  range: '5d'  },
  '15m': { interval: '15m', range: '1mo' },
  '1h':  { interval: '60m', range: '3mo' },
  '1d':  { interval: '1d',  range: '1y'  },
};

function parseCandles(result) {
  const ts = result?.timestamp || [];
  const bars = result?.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const o = bars.open?.[i], hi = bars.high?.[i], lo = bars.low?.[i], c = bars.close?.[i];
    if (o == null || hi == null || lo == null || c == null) continue;
    if (![o, hi, lo, c].every(v => Number.isFinite(v) && v > 0)) continue; // drop bad prints
    out.push({ time: ts[i], open: o, high: hi, low: lo, close: c });
  }
  return sanitizeCandles(out);
}

// Clamp spike wicks. Yahoo occasionally returns a bar whose high/low is wildly
// off (thin overnight prints). We bound each bar's wick to the local price range
// (from neighbouring closes) so those spikes can't render as full-height wicks.
function sanitizeCandles(c) {
  const n = c.length;
  if (n < 5) return c;
  const W = 3;
  for (let i = 0; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
      lo = Math.min(lo, c[j].close); hi = Math.max(hi, c[j].close);
    }
    const b = c[i];
    const bodyHi = Math.max(b.open, b.close), bodyLo = Math.min(b.open, b.close);
    const band = (hi - lo) || bodyHi * 0.0005;
    const capHi = Math.max(bodyHi, hi) + band * 0.5;
    const capLo = Math.min(bodyLo, lo) - band * 0.5;
    if (b.high > capHi) b.high = capHi;
    if (b.low < capLo) b.low = capLo;
    if (b.high < bodyHi) b.high = bodyHi;
    if (b.low > bodyLo) b.low = bodyLo;
  }
  return c;
}

async function yahoo(feed, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feed)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${feed} HTTP ${res.status}`);
  const json = await res.json();
  return json?.chart?.result?.[0];
}

// Fresh quote per feed (price + prevClose), cached ~3s. Returns { feed: {price, prevClose, time} }.
// Warm in-memory caches (per serverless instance) so we don't hit Redis on every
// request. Market data is shared by all users, so a few seconds of warm caching
// eliminates the vast majority of DB reads/writes under live load.
const warm = { quote: {}, candles: {} };

async function ensureQuotes(store) {
  const out = {};
  for (const feed of FEEDS) {
    const wq = warm.quote[feed];
    if (wq && Date.now() - wq.t < 3000) { out[feed] = wq.q; continue; } // serve from warm cache
    let q = await store.getCache('quote:' + feed);
    if (!q || Date.now() - q.time > 3000) {
      try {
        const result = await yahoo(feed, '1m', '2d');
        const meta = result?.meta;
        const candles = parseCandles(result);
        // Price = last chart candle so price/fills/chart share ONE source (no drift/spikes).
        const price = candles.length ? candles[candles.length - 1].close : meta?.regularMarketPrice;
        if (typeof price === 'number') {
          q = {
            price,
            prevClose: meta?.chartPreviousClose ?? meta?.previousClose ?? (q && q.prevClose) ?? null,
            time: Date.now(),
          };
          await store.setCache('quote:' + feed, q, 15);
          await store.setCache('candles:' + feed + ':1m', candles, 15);
          warm.candles[feed + ':1m'] = { c: candles, t: Date.now() };
        }
      } catch (e) {
        if (wq) { out[feed] = wq.q; continue; } // fall back to last warm value
        if (!q) continue;
      }
    }
    warm.quote[feed] = { q, t: Date.now() };
    out[feed] = q;
  }
  return out;
}

async function getCandles(store, feed, tf) {
  const wkey = feed + ':' + tf;
  const w = warm.candles[wkey];
  const ttl = tf === '1m' ? 12000 : 40000;
  if (w && Date.now() - w.t < ttl) return w.c; // warm cache
  const key = 'candles:' + wkey;
  let candles = await store.getCache(key);
  if (!candles) {
    const { interval, range } = TF_MAP[tf];
    candles = parseCandles(await yahoo(feed, interval, range));
    if (candles.length) await store.setCache(key, candles, tf === '1m' ? 15 : 45);
  }
  if (candles && candles.length) warm.candles[wkey] = { c: candles, t: Date.now() };
  return candles;
}

// Build { symbol: price } and a client-facing quotes view from the per-feed quotes.
function views(quotesByFeed) {
  const bySym = {}, view = {};
  for (const [sym, spec] of Object.entries(SPECS)) {
    const q = quotesByFeed[spec.feed];
    if (q && typeof q.price === 'number') bySym[sym] = q.price;
    view[sym] = q ? {
      price: q.price,
      prevClose: q.prevClose,
      change: q.prevClose ? round2(q.price - q.prevClose) : 0,
      time: q.time,
      name: spec.name,
      pointValue: spec.pointValue,
      maxContracts: spec.maxContracts,
    } : null;
  }
  return { bySym, view };
}

module.exports = { FEEDS, TF_MAP, ensureQuotes, getCandles, views, parseCandles, sanitizeCandles };
