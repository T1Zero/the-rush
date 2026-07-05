// OptionDecay's The Rush — client
const $ = id => document.getElementById(id);

let token = localStorage.getItem('ft_token') || null;
let mode = 'login';
let selected = 'ES';
let state = null;
let pollTimer = null;
let prevPrices = {};   // symbol -> last seen price (for flash animation)
let tickerBuilt = false;

// ---------- auth UI ----------
function setMode(m) {
  mode = m;
  $('tabLogin').classList.toggle('active', m === 'login');
  $('tabRegister').classList.toggle('active', m === 'register');
  $('nameRow').classList.toggle('hidden', m === 'login');
  $('authSubmit').querySelector('span').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('authError').textContent = '';
}
$('tabLogin').onclick = () => setMode('login');
$('tabRegister').onclick = () => setMode('register');

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  const body = {
    name: $('fName').value,
    email: $('fEmail').value,
    password: $('fPassword').value,
  };
  const r = await api(`/api/${mode}`, 'POST', body, false);
  if (r.error) { $('authError').textContent = r.error; return; }
  token = r.token;
  localStorage.setItem('ft_token', token);
  showApp();
};

$('btnLogout').onclick = () => {
  token = null;
  localStorage.removeItem('ft_token');
  clearInterval(pollTimer);
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  startParticles();
  initMusic();
};

// ---------- api ----------
async function api(path, method = 'GET', body = null, auth = true) {
  const opts = { method, headers: {} };
  if (auth && token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  try {
    const res = await fetch(path, opts);
    return await res.json();
  } catch {
    return { error: 'Network error' };
  }
}

// ---------- app ----------
function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  stopParticles();
  stopMusic();
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 2000);
}

async function refresh() {
  const r = await api('/api/state');
  if (r.error) {
    if (!state) { // token invalid on load
      token = null; localStorage.removeItem('ft_token');
      clearInterval(pollTimer);
      $('appView').classList.add('hidden');
      $('authView').classList.remove('hidden');
    }
    return;
  }
  state = r;
  render();
}

const fmt = n => (n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtPx = fmt;
const fmtMoney = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtMoney0 = n => (n == null ? '—' : (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'));
const fmtTime = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function pnlClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : ''; }

function render() {
  const { account: a, quotes: q, leaderboard: lb } = state;

  // topbar
  $('uName').textContent = a.name;
  $('sBalance').textContent = fmtMoney(a.balance);
  $('sEquity').textContent = fmtMoney(a.equity);
  $('sUpnl').textContent = fmtMoney(a.unrealized);
  $('sUpnl').className = 'mono ' + pnlClass(a.unrealized);
  $('sDayPnl').textContent = fmtMoney(a.dayPnl);
  $('sDayPnl').className = 'mono ' + pnlClass(a.dayPnl);
  $('sFloor').textContent = fmtMoney(a.drawdownFloor);

  const badge = $('statusBadge');
  if (a.blown) { badge.textContent = 'BLOWN'; badge.className = 'badge dead'; }
  else if (a.dailyLocked) { badge.textContent = 'DAILY LOCK'; badge.className = 'badge warn'; }
  else if (a.sessionClosed) { badge.textContent = 'SESSION CLOSED'; badge.className = 'badge warn'; }
  else { badge.textContent = 'ACTIVE'; badge.className = 'badge ok'; }

  // risk meters
  const dailyUsed = Math.min(1, Math.max(0, -a.dayPnl / a.dailyLossLimit));
  const ddUsed = Math.min(1, Math.max(0, (a.highEquity - a.equity) / (a.highEquity - a.drawdownFloor)));
  setRisk('riskDaily', dailyUsed, `${fmtMoney(Math.max(0, -a.dayPnl))} / $${a.dailyLossLimit.toLocaleString()}`);
  setRisk('riskDD', ddUsed, `${fmtMoney(Math.max(0, a.highEquity - a.equity))} / $${(a.highEquity - a.drawdownFloor).toLocaleString()}`);

  // ticker + watchlist (with tick-flash detection)
  const dirs = {};
  for (const [sym, d] of Object.entries(q)) {
    if (!d) continue;
    const prev = prevPrices[sym];
    dirs[sym] = prev == null || d.price === prev ? '' : (d.price > prev ? 'tick-up' : 'tick-down');
    prevPrices[sym] = d.price;
  }

  updateTicker(q);

  $('watchRows').innerHTML = Object.entries(q).map(([sym, d]) => {
    if (!d) return '';
    const ch = d.change || 0;
    const chPct = d.prevClose ? (ch / d.prevClose * 100) : 0;
    return `<div class="watch-row ${sym === selected ? 'selected' : ''} ${dirs[sym]}" data-sym="${sym}">
      <div><div class="watch-sym">${sym}</div><div class="watch-name">${d.name}</div></div>
      <div class="watch-px">
        <div class="p">${fmtPx(d.price)}</div>
        <div class="c ${pnlClass(ch)}">${ch >= 0 ? '+' : ''}${fmt(ch)} · ${chPct >= 0 ? '+' : ''}${chPct.toFixed(2)}%</div>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.watch-row').forEach(el => {
    el.onclick = () => { selected = el.dataset.sym; render(); };
  });

  // chart + order labels
  const sel = q[selected];
  $('chartTitle').textContent = selected;
  $('chartName').textContent = sel ? sel.name.toUpperCase() : '';
  $('chartPrice').textContent = sel ? fmtPx(sel.price) : '—';
  $('buySym').textContent = selected;
  $('sellSym').textContent = selected;
  const tradingHalted = a.blown || a.dailyLocked || a.sessionClosed;
  $('btnBuy').disabled = tradingHalted;
  $('btnSell').disabled = tradingHalted;
  $('limitHint').textContent = a.sessionClosed
    ? 'Market closed — no overnight holding · resumes 6:00pm ET'
    : (sel ? `max ${sel.maxContracts} · $${sel.pointValue}/pt` : '');
  ensureChart();
  if (sel) tickChart(sel.price);

  // positions
  const posBody = $('posBody');
  if (a.positions.length) {
    posBody.innerHTML = a.positions.map(p => `<tr>
      <td class="td-sym">${p.symbol}</td>
      <td class="num ${p.qty > 0 ? 'pos' : 'neg'}">${p.qty > 0 ? '+' : ''}${p.qty}</td>
      <td class="num">${fmtPx(p.avg)}</td>
      <td class="num">${fmtPx(p.last)}</td>
      <td class="num ${pnlClass(p.upnl)}">${fmtMoney(p.upnl)}</td>
    </tr>`).join('');
    $('noPos').classList.add('hidden');
  } else {
    posBody.innerHTML = '';
    $('noPos').classList.remove('hidden');
  }

  // trades
  const tBody = $('tradesBody');
  if (a.trades.length) {
    tBody.innerHTML = a.trades.map(t => `<tr>
      <td>${fmtTime(t.t)}</td>
      <td class="td-sym">${t.symbol}</td>
      <td class="${t.side === 'BUY' ? 'pos' : 'neg'}">${t.side}${t.note ? ' ⚠' : ''}</td>
      <td class="num">${t.qty}</td>
      <td class="num">${fmtPx(t.price)}</td>
      <td class="num ${pnlClass(t.realized)}">${t.realized == null ? '—' : fmtMoney(t.realized)}</td>
    </tr>`).join('');
    $('noTrades').classList.add('hidden');
  } else {
    tBody.innerHTML = '';
    $('noTrades').classList.remove('hidden');
  }

  // leaderboard — organizer (admin) only. Regular users never receive `lb`.
  document.body.classList.toggle('is-admin', !!a.isAdmin);
  if (a.isAdmin && lb) {
    const medal = i => i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
    $('lbBody').innerHTML = lb.map((u, i) => `<tr class="${u.name === a.name ? 'lb-me' : ''}">
      <td class="rank ${medal(i)}">${String(i + 1).padStart(2, '0')}</td>
      <td title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</td>
      <td class="num">${fmtMoney0(u.equity)}</td>
      <td class="num ${pnlClass(u.pnl)}">${fmtMoney0(u.pnl)}</td>
      <td class="num">${u.status === 'BLOWN' ? '💀' : u.status === 'LOCKED' ? '🔒' : '🟢'}</td>
    </tr>`).join('');
  }
}

function setRisk(prefix, used, label) {
  const fill = $(prefix + 'Fill');
  fill.style.width = (used * 100).toFixed(1) + '%';
  fill.classList.toggle('hot', used > 0.6);
  $(prefix + 'Txt').textContent = label;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- ticker tape ----------
function updateTicker(q) {
  const syms = Object.keys(q).filter(s => q[s]);
  if (!syms.length) return;
  if (!tickerBuilt) {
    const group = syms.map(sym =>
      `<span class="tk"><b>${sym}</b><span class="tkp" data-tk="${sym}">—</span><span class="tkc" data-tkc="${sym}">—</span></span>`
    ).join('').repeat(3);
    $('tickerTrack').innerHTML = `<span class="tk-group">${group}</span><span class="tk-group">${group}</span>`;
    tickerBuilt = true;
  }
  for (const sym of syms) {
    const d = q[sym];
    const ch = d.change || 0;
    document.querySelectorAll(`[data-tk="${sym}"]`).forEach(el => {
      el.textContent = fmtPx(d.price);
      el.className = 'tkp ' + pnlClass(ch);
    });
    document.querySelectorAll(`[data-tkc="${sym}"]`).forEach(el => {
      el.textContent = `${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}`;
      el.className = 'tkc ' + pnlClass(ch);
    });
  }
}

// ---------- Candlestick chart (TradingView Lightweight Charts + our own feed) ----------
let chart = null, candleSeries = null;
let timeframe = localStorage.getItem('ft_tf') || '1m';
let chartKeyLoaded = null; // "SYM|tf" currently displayed
let chartLoading = null;   // "SYM|tf" currently being fetched
let lastBar = null;        // most recent bar (for live tick updates)
let candlesTimer = null;

const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 };
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60; // display local time on a UTC-based axis
const chartKey = () => `${selected}|${timeframe}`;

function initChart() {
  if (chart || typeof LightweightCharts === 'undefined') return;
  chart = LightweightCharts.createChart($('chartBox'), {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#6b7899',
      fontFamily: 'Inter',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(0, 229, 255, .05)' },
      horzLines: { color: 'rgba(0, 229, 255, .05)' },
    },
    crosshair: {
      vertLine: { color: 'rgba(0, 229, 255, .35)', labelBackgroundColor: '#1a2135' },
      horzLine: { color: 'rgba(0, 229, 255, .35)', labelBackgroundColor: '#1a2135' },
    },
    rightPriceScale: { borderColor: 'rgba(0, 229, 255, .12)' },
    timeScale: { borderColor: 'rgba(0, 229, 255, .12)', timeVisible: true, secondsVisible: false },
  });
  candleSeries = chart.addCandlestickSeries({
    upColor: '#00ff9d', downColor: '#ff3b5c',
    wickUpColor: '#00ff9d', wickDownColor: '#ff3b5c',
    borderVisible: false,
  });
}

async function loadCandles(key) {
  const [symbol, tf] = key.split('|');
  const r = await api(`/api/candles?symbol=${symbol}&tf=${tf}`, 'GET', null, false);
  if (chartLoading === key) chartLoading = null;
  if (r.error || !r.candles || !r.candles.length || key !== chartKey()) return;
  initChart();
  if (!candleSeries) return;
  const data = r.candles.map(c => ({ ...c, time: c.time + TZ_SHIFT }));
  candleSeries.setData(data);
  lastBar = data[data.length - 1] || null;
  if (chartKeyLoaded !== key) chart.timeScale().scrollToRealTime();
  chartKeyLoaded = key;
}

function ensureChart() {
  initChart();
  const key = chartKey();
  if (chartKeyLoaded === key || chartLoading === key) return;
  chartLoading = key;
  lastBar = null;
  loadCandles(key);
  clearInterval(candlesTimer);
  candlesTimer = setInterval(() => { if (chartKeyLoaded === chartKey()) loadCandles(chartKey()); }, 60000);
}

// paint the live price onto the current bar between full refreshes
function tickChart(price) {
  if (!candleSeries || price == null || chartKeyLoaded !== chartKey()) return;
  const sec = TF_SEC[timeframe] || 60;
  const t = Math.floor((Date.now() / 1000 + TZ_SHIFT) / sec) * sec;
  if (lastBar && t <= lastBar.time) {
    lastBar.close = price;
    lastBar.high = Math.max(lastBar.high, price);
    lastBar.low = Math.min(lastBar.low, price);
    candleSeries.update({ ...lastBar });
  } else if (lastBar && price !== lastBar.close) {
    lastBar = { time: t, open: lastBar.close, high: Math.max(lastBar.close, price), low: Math.min(lastBar.close, price), close: price };
    candleSeries.update({ ...lastBar });
  }
}

// timeframe switcher
document.querySelectorAll('.tf-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.tf === timeframe);
  b.onclick = () => {
    timeframe = b.dataset.tf;
    localStorage.setItem('ft_tf', timeframe);
    document.querySelectorAll('.tf-btn').forEach(x => x.classList.toggle('active', x.dataset.tf === timeframe));
    ensureChart();
  };
});

// ---------- orders ----------
async function order(side) {
  const qty = parseInt($('qty').value, 10);
  const msg = $('orderMsg');
  msg.textContent = '';
  const r = await api('/api/order', 'POST', { symbol: selected, side, qty });
  if (r.error) {
    msg.textContent = '✕ ' + r.error;
    msg.className = 'order-msg neg';
  } else {
    const f = r.fill;
    msg.textContent = `✓ Filled · ${f.side.toUpperCase()} ${f.qty} ${f.symbol} @ ${fmtPx(f.price)} · 0 slippage`;
    msg.className = 'order-msg pos';
    refresh();
  }
}
$('btnBuy').onclick = () => order('buy');
$('btnSell').onclick = () => order('sell');
$('btnFlatten').onclick = async () => {
  await api('/api/flatten', 'POST', {});
  $('orderMsg').textContent = '✓ All positions flattened';
  $('orderMsg').className = 'order-msg pos';
  refresh();
};
$('qtyMinus').onclick = () => { $('qty').value = Math.max(1, (parseInt($('qty').value, 10) || 1) - 1); };
$('qtyPlus').onclick = () => { $('qty').value = (parseInt($('qty').value, 10) || 0) + 1; };

// ---------- login FX: floating particles ----------
let particleRAF = null;
function startParticles() {
  const canvas = document.getElementById('particles');
  if (!canvas || particleRAF) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  const mouse = { x: -9999, y: -9999 };

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const nodeN = Math.max(28, Math.min(60, Math.floor(W * H / 19000)));
  const nodes = Array.from({ length: nodeN }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - .5) * 0.25, vy: (Math.random() - .5) * 0.25,
    r: Math.random() * 1.6 + 0.6,
    c: Math.random() < 0.55 ? '0,229,255' : '139,92,246',
  }));
  // white motes drifting up through the whole screen
  const floatN = Math.max(80, Math.min(185, Math.floor(W * H / 6500)));
  const floaters = Array.from({ length: floatN }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - .5) * 0.16, vy: -(Math.random() * 0.28 + 0.05),
    r: Math.random() * 1.6 + 0.5,
    a: Math.random() * 0.45 + 0.25,
    tw: Math.random() * Math.PI * 2, tws: Math.random() * 0.03 + 0.008,
  }));

  const onMove = e => { const b = canvas.getBoundingClientRect(); mouse.x = e.clientX - b.left; mouse.y = e.clientY - b.top; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('resize', resize);
  canvas._cleanup = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('resize', resize); };

  function frame() {
    ctx.clearRect(0, 0, W, H);

    // white floating particles
    for (const f of floaters) {
      f.x += f.vx; f.y += f.vy; f.tw += f.tws;
      if (f.y < -5) { f.y = H + 5; f.x = Math.random() * W; }
      if (f.x < -5) f.x = W + 5; else if (f.x > W + 5) f.x = -5;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${f.a * (0.55 + 0.45 * Math.sin(f.tw))})`;
      ctx.shadowColor = 'rgba(255,255,255,0.8)'; ctx.shadowBlur = 6;
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // cyan/violet network
    for (const p of nodes) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
      if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},0.85)`;
      ctx.shadowColor = `rgba(${p.c},0.9)`; ctx.shadowBlur = 7;
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
        if (d < 120) {
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = `rgba(0,229,255,${0.12 * (1 - d / 120)})`;
          ctx.lineWidth = 1; ctx.stroke();
        }
      }
      const mdx = a.x - mouse.x, mdy = a.y - mouse.y, md = Math.hypot(mdx, mdy);
      if (md < 160) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y);
        ctx.strokeStyle = `rgba(139,92,246,${0.28 * (1 - md / 160)})`;
        ctx.lineWidth = 1; ctx.stroke();
      }
    }
    particleRAF = requestAnimationFrame(frame);
  }
  frame();
}
function stopParticles() {
  if (particleRAF) { cancelAnimationFrame(particleRAF); particleRAF = null; }
  const c = document.getElementById('particles');
  if (c && c._cleanup) { c._cleanup(); c._cleanup = null; }
}

// ---------- login FX: music ----------
// Default is a free-to-use placeholder track — swap in your own by dropping
// public/music.mp3 (or give me a link) and pointing TRACK.url at it.
const TRACK = { url: 'music.mp3' };
const bgm = document.getElementById('bgm');
let userPausedMusic = false;

function updateVolUI(v) {
  const sl = document.getElementById('musicVol');
  // rotated slider: left→right renders bottom→top, so fill from 0 to v%
  if (sl) sl.style.background = `linear-gradient(90deg, var(--cyan) 0 ${v}%, rgba(255,255,255,.16) ${v}% 100%)`;
}

const isDesktop = () => window.matchMedia('(min-width: 561px)').matches;

function initMusic() {
  if (!bgm || !isDesktop()) return; // music is desktop-only
  const vol = parseInt(localStorage.getItem('ft_vol') ?? '35', 10);
  const volEl = document.getElementById('musicVol');
  volEl.value = vol;
  bgm.volume = vol / 100;
  if (!bgm.src) bgm.src = TRACK.url;
  updateVolUI(vol);

  document.getElementById('musicToggle').onclick = (e) => {
    e.stopPropagation();
    userPausedMusic = false;
    if (bgm.paused) playMusic(); else { bgm.pause(); userPausedMusic = true; setMusicUI(false); }
  };
  volEl.oninput = () => { bgm.volume = volEl.value / 100; localStorage.setItem('ft_vol', volEl.value); updateVolUI(volEl.value); };

  // autostart on entering / reload — browsers may block sound until a gesture,
  // so we also arm a one-time start on the first click/keypress as a fallback.
  userPausedMusic = false;
  playMusic();
  armMusicAutostart();
}
function playMusic() {
  bgm.play().then(() => setMusicUI(true)).catch(() => setMusicUI(false));
}
function setMusicUI(on) {
  const t = document.getElementById('musicToggle');
  if (!t) return;
  t.textContent = on ? '❚❚' : '▶';
  t.classList.toggle('playing', on);
}
function stopMusic() { if (bgm) bgm.pause(); setMusicUI(false); }
// browsers block autoplay until a gesture — start on the first click/keypress
function armMusicAutostart() {
  const kick = () => {
    document.removeEventListener('click', kick);
    document.removeEventListener('keydown', kick);
    if (!userPausedMusic && bgm && bgm.paused) playMusic();
  };
  document.addEventListener('click', kick);
  document.addEventListener('keydown', kick);
}

// ---------- boot ----------
if (token) {
  showApp();
} else {
  $('authView').classList.remove('hidden');
  startParticles();
  initMusic();
}
