// Pure trading logic — operates on plain user objects + a { symbol: price } map.
// No I/O here; callers load the user, run these, then persist.
const crypto = require('crypto');

const SPECS = {
  ES:  { name: 'E-mini S&P 500',        pointValue: 50, tick: 0.25, maxContracts: 2,  feed: 'ES=F' },
  NQ:  { name: 'E-mini Nasdaq-100',     pointValue: 20, tick: 0.25, maxContracts: 2,  feed: 'NQ=F' },
  MES: { name: 'Micro E-mini S&P 500',  pointValue: 5,  tick: 0.25, maxContracts: 20, feed: 'ES=F' },
  MNQ: { name: 'Micro E-mini Nasdaq',   pointValue: 2,  tick: 0.25, maxContracts: 20, feed: 'MNQ=F' },
};
// MNQ tracks NQ; keep its feed as NQ (the line above is corrected here to avoid a bad feed id)
SPECS.MNQ.feed = 'NQ=F';

const START_BALANCE = 50000;
const MAX_DRAWDOWN = 2000;
const DRAWDOWN_FLOOR = START_BALANCE - MAX_DRAWDOWN; // 48,000 — STATIC hard floor; equity under this blows the account
const DAILY_LOSS_LIMIT = 1000;

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'mail@mail.com').toLowerCase();
const ONE_ACCOUNT_PER_IP = process.env.ONE_ACCOUNT_PER_IP !== '0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
// Demo escape hatch: set to 1 to ignore market hours / the no-overnight rule (lets you test trading when the market is closed).
const IGNORE_MARKET_HOURS = process.env.IGNORE_MARKET_HOURS === '1';

const round2 = n => Math.round(n * 100) / 100;

function tradingDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Current time in America/New_York as { dow (0=Sun), hour, min }.
function etNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = t => parts.find(p => p.type === t)?.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: wd[get('weekday')], hour: parseInt(get('hour'), 10) % 24, min: parseInt(get('min') || get('minute'), 10) };
}

// Competition session = regular US market hours: 9:30 AM – 4:00 PM ET, Mon–Fri.
// Outside this window trading is closed for players and open positions are flattened.
function noHoldAt(dow, hour, min) {
  if (dow === 0 || dow === 6) return true;             // weekend — closed
  const t = hour * 60 + min;
  return t < 9 * 60 + 30 || t >= 16 * 60;              // before 9:30am or at/after 4:00pm ET
}

function noHold() {
  if (IGNORE_MARKET_HOURS) return false;
  const { dow, hour, min } = etNow();
  return noHoldAt(dow, hour, min);
}

function hasOpen(user) { return Object.values(user.positions).some(p => p.qty !== 0); }
const isAdminUser = u => !!u && u.email === ADMIN_EMAIL;

function priceOf(symbol, px) { return px && px[symbol] != null ? px[symbol] : null; }

function unrealized(user, px) {
  let u = 0;
  for (const [sym, pos] of Object.entries(user.positions)) {
    const p = priceOf(sym, px);
    if (p == null || !pos.qty) continue;
    u += (p - pos.avg) * pos.qty * SPECS[sym].pointValue;
  }
  return u;
}

function rollDay(user, px) {
  const today = tradingDay();
  if (user.day !== today) {
    user.day = today;
    user.dayStartEquity = user.balance + unrealized(user, px);
    user.dailyLocked = false;  // the daily-loss lock clears at the start of a new day
  }
}

function flattenAll(user, px, reason) {
  for (const [sym, pos] of Object.entries(user.positions)) {
    if (!pos.qty) continue;
    const p = priceOf(sym, px);
    if (p == null) continue;
    const realized = (p - pos.avg) * pos.qty * SPECS[sym].pointValue;
    user.balance += realized;
    user.trades.push({
      t: Date.now(), symbol: sym, side: pos.qty > 0 ? 'SELL' : 'BUY',
      qty: Math.abs(pos.qty), price: p, realized: round2(realized), note: reason,
    });
    pos.qty = 0; pos.avg = 0;
  }
  trimTrades(user);
}

function posSig(user) { return Object.entries(user.positions).map(([s, p]) => `${s}${p.qty}:${p.avg}`).join('|'); }

// Returns true if the account state changed (so the caller knows to persist).
function enforceRisk(user, px) {
  const snap = () => JSON.stringify([user.balance, user.blown, user.dailyLocked, user.highEquity, user.day, user.trades.length, posSig(user)]);
  const before = snap();
  rollDay(user, px);

  // Outside market hours: flatten players' open positions (admin is exempt for testing).
  if (noHold() && !isAdminUser(user) && hasOpen(user)) flattenAll(user, px, 'MARKET CLOSED — positions flattened at 4:00pm ET');

  const equity = user.balance + unrealized(user, px);

  // Static $2k drawdown: equity under the fixed $48,000 floor = hard blow (account over).
  if (!user.blown && equity <= DRAWDOWN_FLOOR) {
    flattenAll(user, px, 'MAX DRAWDOWN — account blown (equity under $48,000)');
    user.blown = true;
  } else if (!user.blown && !user.dailyLocked && equity - user.dayStartEquity <= -DAILY_LOSS_LIMIT) {
    // Daily loss limit is a soft breach: flatten + locked for the rest of the day.
    flattenAll(user, px, 'DAILY LOSS LIMIT — locked for the day');
    user.dailyLocked = true;
  }
  return before !== snap();
}

function trimTrades(user) {
  if (user.trades.length > 200) user.trades = user.trades.slice(-200);
}

function accountView(user, px) {
  const unrl = unrealized(user, px);
  const equity = user.balance + unrl;
  return {
    name: user.name,
    email: user.email,
    isAdmin: user.email === ADMIN_EMAIL,
    balance: round2(user.balance),
    unrealized: round2(unrl),
    equity: round2(equity),
    dayPnl: round2(equity - user.dayStartEquity),
    dailyLossLimit: DAILY_LOSS_LIMIT,
    drawdownFloor: DRAWDOWN_FLOOR,
    startBalance: START_BALANCE,
    maxDrawdown: MAX_DRAWDOWN,
    blown: user.blown,
    dailyLocked: user.dailyLocked,
    sessionClosed: noHold(),
    canTrade: isAdminUser(user) || !noHold(),
    positions: Object.entries(user.positions)
      .filter(([, p]) => p.qty !== 0)
      .map(([sym, p]) => {
        const last = priceOf(sym, px);
        return {
          symbol: sym, qty: p.qty, avg: p.avg, last,
          upnl: last == null ? 0 : round2((last - p.avg) * p.qty * SPECS[sym].pointValue),
        };
      }),
    trades: user.trades.slice(-30).reverse(),
  };
}

function placeOrder(user, px, symbol, side, qty) {
  const spec = SPECS[symbol];
  if (!spec) return { error: 'Unknown symbol. Tradeable: ES, NQ, MES, MNQ.' };
  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty < 1) return { error: 'Quantity must be a whole number ≥ 1.' };
  if (side !== 'buy' && side !== 'sell') return { error: 'Side must be buy or sell.' };

  enforceRisk(user, px);
  if (user.blown) return { error: 'Account blown — equity fell below $48,000 (max drawdown). Competition over for this account.' };
  if (user.dailyLocked) return { error: 'Daily loss limit hit — trading locked for the rest of the day.' };
  if (noHold() && !isAdminUser(user)) return { error: 'Trading opens at 9:30 AM ET (Mon–Fri). Positions auto-flatten at the 4:00 PM close.' };

  const p = priceOf(symbol, px);
  if (p == null) return { error: 'No market data yet — try again in a few seconds.' };

  const pos = user.positions[symbol] || (user.positions[symbol] = { qty: 0, avg: 0 });
  const delta = side === 'buy' ? qty : -qty;
  const newQty = pos.qty + delta;
  if (Math.abs(newQty) > spec.maxContracts) {
    return { error: `Position limit: max ${spec.maxContracts} contracts on ${symbol} (would be ${Math.abs(newQty)}).` };
  }

  let realized = 0;
  if (pos.qty !== 0 && Math.sign(delta) !== Math.sign(pos.qty)) {
    const closing = Math.min(Math.abs(delta), Math.abs(pos.qty));
    realized = (p - pos.avg) * closing * Math.sign(pos.qty) * spec.pointValue;
    user.balance += realized;
    if (Math.abs(delta) > Math.abs(pos.qty)) { pos.qty = newQty; pos.avg = p; }
    else { pos.qty = newQty; if (pos.qty === 0) pos.avg = 0; }
  } else {
    pos.avg = pos.qty === 0 ? p : (pos.avg * Math.abs(pos.qty) + p * qty) / (Math.abs(pos.qty) + qty);
    pos.qty = newQty;
  }

  user.trades.push({
    t: Date.now(), symbol, side: side.toUpperCase(), qty, price: p,
    realized: realized ? round2(realized) : null,
  });
  trimTrades(user);
  enforceRisk(user, px);
  return { ok: true, fill: { symbol, side, qty, price: p } };
}

function newUser(name, email, password, ip) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    name, email, salt, hash: hashPassword(password, salt),
    ip: ip || '',
    balance: START_BALANCE, highEquity: START_BALANCE,
    day: tradingDay(), dayStartEquity: START_BALANCE,
    dailyLocked: false, blown: false,
    positions: {}, trades: [], created: Date.now(),
  };
}

// Reset an account to a clean $50k (keeps credentials/name/ip/created).
function resetAccount(u) {
  u.balance = START_BALANCE;
  u.highEquity = START_BALANCE;
  u.dayStartEquity = START_BALANCE;
  u.day = tradingDay();
  u.dailyLocked = false;
  u.blown = false;
  u.positions = {};
  u.trades = [];
}

function leaderboard(users, pxBySym) {
  return users
    .map(u => {
      const equity = u.balance + unrealized(u, pxBySym);
      return {
        name: u.name,
        equity: round2(equity),
        pnl: round2(equity - START_BALANCE),
        status: u.blown ? 'BLOWN' : (u.dailyLocked ? 'LOCKED' : 'ACTIVE'),
        _c: u.created || 0,   // sort tiebreakers (stripped before send)
        _e: u.email || '',
      };
    })
    // highest equity first; ties broken deterministically by join time then email
    // so tied rows keep a fixed order instead of shuffling every refresh.
    .sort((a, b) => (b.equity - a.equity) || (a._c - b._c) || (a._e < b._e ? -1 : a._e > b._e ? 1 : 0))
    .slice(0, 1000)
    .map(({ _c, _e, ...row }) => row);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  SPECS, START_BALANCE, DAILY_LOSS_LIMIT,
  ADMIN_EMAIL, ONE_ACCOUNT_PER_IP, TRUST_PROXY, IGNORE_MARKET_HOURS,
  MAX_DRAWDOWN, DRAWDOWN_FLOOR,
  round2, tradingDay, unrealized, enforceRisk, accountView, placeOrder,
  flattenAll, newUser, resetAccount, leaderboard, hashPassword, safeEqual,
  noHold, noHoldAt, etNow,
};
