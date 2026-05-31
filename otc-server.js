// ============================================================
// otc-server.js — OTC Candle Generator Server
// Render.com এ 24/7 চলবে।
// Firestore onSnapshot — Admin থেকে market add করলেই auto start।
// ============================================================

const { initializeApp }                                          = require('firebase/app');
const { getDatabase, ref, push, set, get, onValue, query, orderByKey, limitToLast } = require('firebase/database');
const { getFirestore, collection, onSnapshot }                   = require('firebase/firestore');

// ── Firebase config ──────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyAuroZ3rEZUurcBmcSv5i9KC6h2O4quesg",
  authDomain:        "deepseek-e2447.firebaseapp.com",
  projectId:         "deepseek-e2447",
  storageBucket:     "deepseek-e2447.firebasestorage.app",
  messagingSenderId: "407180815537",
  appId:             "1:407180815537:web:df596448f599348e558690",
  databaseURL:       "https://deepseek-e2447-default-rtdb.firebaseio.com"
};

const app      = initializeApp(firebaseConfig);
const db       = getDatabase(app);
const firestore = getFirestore(app);

// ── OTC Admin Controls cache (per symbol) ────────────────
const _controls = {};

const TICK_MS   = 500;
const CANDLE_MS = 60 * 1000;

// ── Per-symbol state ─────────────────────────────────────
const _states = {};

// ── Active tick symbols set ───────────────────────────────
const _activeMarkets = new Set();

// ── Fetch real price from Binance ────────────────────────
async function fetchRealPrice(symbol) {
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    const data = await res.json();
    return parseFloat(data.price) || 0;
  } catch (e) {
    return 0;
  }
}

// ── Load last saved candle from Firebase ─────────────────
async function loadLastCandle(id, baseSymbol) {
  try {
    const r    = ref(db, `otc_candles/${id}/candles`);
    const q    = query(r, orderByKey(), limitToLast(1));
    const snap = await get(q);
    if (snap.exists()) {
      const vals = Object.values(snap.val());
      console.log(`[${id}] Last candle from Firebase: time=${vals[0].time} close=$${vals[0].close}`);
      return vals[0];
    }
  } catch (e) {}
  const p = await fetchRealPrice(baseSymbol);
  const price = p > 0 ? p : 100;
  console.log(`[${id}] Starting fresh from Binance @ $${price}`);
  return null;
}

// ── Save candle to Firebase ──────────────────────────────
async function saveCandle(id, candle) {
  try {
    const r = ref(db, `otc_candles/${id}/candles`);
    await push(r, candle);
    console.log(`[${id}] Candle saved: close=$${candle.close.toFixed(4)} time=${new Date(candle.time * 1000).toISOString()}`);
  } catch (e) {
    console.error(`[${id}] Save failed:`, e.message);
  }
}

// ── Save live (running) candle to Firebase ───────────────
function saveLiveCandle(id, candle) {
  try {
    const r = ref(db, `otc_candles/${id}/live`);
    set(r, candle).catch(() => {});
  } catch (e) {}
}

function randomTrend() {
  const r = Math.random();
  if (r < 0.38) return 1;
  if (r < 0.76) return -1;
  return 0;
}

// ── Backfill missing candles ─────────────────────────────
async function backfillCandles(id, lastCandleTime, lastPrice) {
  const now          = Math.floor(Date.now() / 1000);
  const candleSec    = CANDLE_MS / 1000;
  const firstMissing = lastCandleTime + candleSec;
  const lastMissing  = Math.floor(now / candleSec) * candleSec - candleSec;
  const missingCount = Math.floor((lastMissing - lastCandleTime) / candleSec);

  if (missingCount <= 0) return lastPrice;

  const toFill = Math.min(missingCount, 480);
  console.log(`[${id}] Backfilling ${toFill} missing candles...`);

  let price = lastPrice, trend = 0, trendSteps = 0;

  for (let i = 0; i < toFill; i++) {
    const candleTime = firstMissing + (i * candleSec);
    if (trendSteps <= 0) {
      const r = Math.random();
      trend = r < 0.38 ? 1 : r < 0.76 ? -1 : 0;
      trendSteps = 8 + Math.floor(Math.random() * 12);
    }
    trendSteps--;
    let open = price, high = price, low = price;
    for (let t = 0; t < 120; t++) {
      const volatility = price * 0.0008;
      const trendBias  = trend * volatility * 0.4;
      const noise      = (Math.random() - 0.5) * volatility * 2;
      price = Math.max(price + trendBias + noise, 0.0001);
      if (price > high) high = price;
      if (price < low)  low  = price;
    }
    await saveCandle(id, { time: candleTime, open, high, low, close: price });
  }

  console.log(`[${id}] Backfill complete. Last price: $${price.toFixed(4)}`);
  return price;
}

// ── Initialize one symbol ────────────────────────────────
async function initSymbol(market) {
  const { id, baseSymbol, startPrice: fixedStart } = market;

  // Already running — skip
  if (_activeMarkets.has(id)) {
    console.log(`[${id}] Already running, skipping init.`);
    return;
  }

  const lastCandle = await loadLastCandle(id, baseSymbol);

  let startPrice;
  const now       = Date.now();
  const candleSec = CANDLE_MS / 1000;
  const nowSec    = Math.floor(now / 1000);

  if (lastCandle) {
    const lastTime        = lastCandle.time;
    const currentBoundary = Math.floor(nowSec / candleSec) * candleSec;
    const gapCandles      = Math.floor((currentBoundary - lastTime) / candleSec) - 1;
    if (gapCandles > 0) {
      startPrice = await backfillCandles(id, lastTime, lastCandle.close);
    } else {
      startPrice = lastCandle.close;
      console.log(`[${id}] Resumed from Firebase @ $${startPrice}`);
    }
  } else {
    if (baseSymbol) {
      startPrice = await fetchRealPrice(baseSymbol);
      if (!startPrice || startPrice <= 0) startPrice = fixedStart || 100;
      console.log(`[${id}] Starting fresh from Binance @ $${startPrice}`);
    } else {
      startPrice = fixedStart || 1.0;
      console.log(`[${id}] Starting fresh with fixed price @ $${startPrice}`);
    }
  }

  // Admin control listener
  _controls[id] = { mode: 'auto', nextDirection: 'auto', volatility: 'medium', trendStrength: 0.6, wickFactor: 0.4, speedMultiplier: 1.0 };
  const ctrlRef = ref(db, `otc_controls/${id}`);
  onValue(ctrlRef, (snap) => {
    if (snap.exists()) _controls[id] = { ..._controls[id], ...snap.val() };
  });

  const candleStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;
  _states[id] = {
    price:      startPrice,
    candleOpen: startPrice,
    candleHigh: startPrice,
    candleLow:  startPrice,
    candleTime: candleStart / 1000,
    nextCandle: candleStart + CANDLE_MS,
    trend:      0,
    trendSteps: 0,
  };

  _activeMarkets.add(id);
  console.log(`[${id}] Engine started ✅`);
}

// ── Stop one symbol ──────────────────────────────────────
function stopSymbol(id) {
  if (!_activeMarkets.has(id)) return;
  _activeMarkets.delete(id);
  delete _states[id];
  delete _controls[id];
  // live candle clear
  set(ref(db, `otc_candles/${id}/live`), null).catch(() => {});
  console.log(`[${id}] Engine stopped ⛔`);
}

// ── Tick one symbol ──────────────────────────────────────
async function tick(id) {
  const state = _states[id];
  if (!state) return;

  const now      = Date.now();
  const ctrl     = _controls[id] || {};
  const volMap   = { low: 0.4, medium: 1.0, high: 2.2 };
  const volMul   = volMap[ctrl.volatility] || 1.0;
  const speed    = ctrl.speedMultiplier || 1.0;
  const trendStr = ctrl.trendStrength || 0.6;

  if (!ctrl.mode || ctrl.mode === 'auto') {
    if (state.trendSteps <= 0) {
      state.trend      = randomTrend();
      state.trendSteps = Math.round((8 + Math.floor(Math.random() * 12)) / speed);
    }
    state.trendSteps--;
  } else if (ctrl.mode === 'manual') {
    const dir = ctrl.nextDirection;
    state.trend      = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
    state.trendSteps = 99;
  } else if (ctrl.mode === 'trade-based') {
    if (state.trendSteps <= 0) state.trendSteps = 8 + Math.floor(Math.random() * 8);
    state.trendSteps--;
  }

  const volatility = state.price * 0.0008 * volMul;
  const trendBias  = state.trend * volatility * trendStr;
  const noise      = (Math.random() - 0.5) * volatility * 2;
  state.price      = Math.max(state.price + (trendBias + noise) * speed, 0.0001);

  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  if (now >= state.nextCandle) {
    await saveCandle(id, {
      time:  state.candleTime,
      open:  state.candleOpen,
      high:  state.candleHigh,
      low:   state.candleLow,
      close: state.price
    });

    set(ref(db, `otc_candles/${id}/live`), null).catch(() => {});

    state.candleTime  = state.nextCandle / 1000;
    state.candleOpen  = state.price;
    state.candleHigh  = state.price;
    state.candleLow   = state.price;
    state.nextCandle += CANDLE_MS;

    while (state.nextCandle <= now) {
      state.candleTime  = state.nextCandle / 1000;
      state.nextCandle += CANDLE_MS;
    }
  } else {
    saveLiveCandle(id, {
      time:       state.candleTime,
      open:       state.candleOpen,
      high:       state.candleHigh,
      low:        state.candleLow,
      close:      state.price,
      nextCandle: state.nextCandle
    });
  }
}

// ── Firestore onSnapshot — Admin market add/remove detect ─
function watchFirestoreMarkets() {
  const marketsCol = collection(firestore, 'markets');

  onSnapshot(marketsCol, (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      const data = change.doc.data();
      const id   = change.doc.id;

      // শুধু OTC market — binance real feed skip
      const isOTC = data.otc === true || data.feed === 'otc-engine' || data.feed === 'usdtbdt-engine';
      if (!isOTC) return;

      if (change.type === 'added' || change.type === 'modified') {
        // visible false হলে stop
        if (data.visible === false) {
          stopSymbol(id);
          return;
        }
        // নতুন বা updated market — init করো
        await initSymbol({
          id,
          baseSymbol:  data.baseSymbol || null,
          startPrice:  data.startPrice || 1.0,
        });
      }

      if (change.type === 'removed') {
        stopSymbol(id);
      }
    });
  }, (err) => {
    console.error('[Firestore] onSnapshot error:', err.message);
  });

  console.log('[Firestore] Watching markets collection...');
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('OTC Server starting...');

  // Firestore market watch শুরু করো
  watchFirestoreMarkets();

  // Tick loop — প্রতি 500ms active markets tick করো
  setInterval(() => {
    _activeMarkets.forEach(id => tick(id));
  }, TICK_MS);

  console.log('OTC Server running. Waiting for markets from Firestore...');
}

main().catch(console.error);

// ── HTTP server — Render alive রাখার জন্য ───────────────
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`OTC Worker Running | Active: ${[..._activeMarkets].join(', ') || 'none'}`);
}).listen(process.env.PORT || 3000, () => {
  console.log('HTTP server listening on port', process.env.PORT || 3000);
});

// ── Self-ping ────────────────────────────────────────────
setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/')
    .then(() => console.log('[keepalive] self-ping OK'))
    .catch(e => console.warn('[keepalive] ping failed:', e.message));
}, 14 * 60 * 1000);
