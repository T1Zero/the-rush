// Market data — fetched on demand from Yahoo Finance and cached in the store,
// so it works on serverless (no background loop needed).
const { SPECS, round2 } = require('./logic');

const FEEDS = ['ES=F', 'NQ=F'];
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
    out.push({ time: ts[i], open: o, high: hi, low: lo, close: c });
  }
  return out;
}

async function yahoo(feed, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(feed)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`yahoo ${feed} HTTP ${res.status}`);
  const json = await res.json();
  return json?.chart?.result?.[0];
}

// Fresh quote per feed (price + prevClose), cached ~3s. Returns { feed: {price, prevClose, time} }.
async function ensureQuotes(store) {
  const out = {};
  for (const feed of FEEDS) {
    let q = await store.getCache('quote:' + feed);
    if (!q || Date.now() - q.time > 3000) {
      try {
        const result = await yahoo(feed, '1m', '2d');
        const meta = result?.meta;
        const price = meta?.regularMarketPrice;
        if (typeof price === 'number') {
          q = {
            price,
            prevClose: meta.chartPreviousClose ?? meta.previousClose ?? (q && q.prevClose) ?? null,
            time: Date.now(),
          };
          await store.setCache('quote:' + feed, q, 15);
          await store.setCache('candles:' + feed + ':1m', parseCandles(result), 15);
        }
      } catch (e) {
        if (!q) continue; // no cached fallback — skip this feed
      }
    }
    out[feed] = q;
  }
  return out;
}

async function getCandles(store, feed, tf) {
  const key = 'candles:' + feed + ':' + tf;
  const hit = await store.getCache(key);
  if (hit) return hit;
  const { interval, range } = TF_MAP[tf];
  const candles = parseCandles(await yahoo(feed, interval, range));
  if (candles.length) await store.setCache(key, candles, tf === '1m' ? 15 : 45);
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

module.exports = { FEEDS, TF_MAP, ensureQuotes, getCandles, views };
