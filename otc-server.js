// ============================================================
// otc-server.js — OTC Candle Generator Server
// Render.com এ 24/7 চলবে।
// প্রতি মিনিটে সব OTC symbol এর candle generate করে Firebase এ save করে।
// ============================================================

const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, query, orderByKey, limitToLast, get } = require('firebase/database');

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

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);

// ── OTC Markets ──────────────────────────────────────────
const OTC_MARKETS = [
  { id: 'BTCOTC', baseSymbol: 'BTCUSDT' },
  { id: 'ETHOTC', baseSymbol: 'ETHUSDT' },
  { id: 'BNBOTC', baseSymbol: 'BNBUSDT' },
  { id: 'SOLOTC', baseSymbol: 'SOLUSDT' },
];

const TICK_MS   = 500;
const CANDLE_MS = 60 * 1000;

// ── Per-symbol state ─────────────────────────────────────
const _states = {};

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
      return vals[0]; // { time, open, high, low, close }
    }
  } catch (e) {}
  // Firebase এ কিছু নেই → Binance থেকে price নাও
  const p = await fetchRealPrice(baseSymbol);
  const price = p > 0 ? p : 100;
  console.log(`[${id}] Starting fresh from Binance @ $${price}`);
  return null; // null মানে fresh start
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

// ── Random trend ─────────────────────────────────────────
function randomTrend() {
  const r = Math.random();
  if (r < 0.38) return 1;
  if (r < 0.76) return -1;
  return 0;
}

// ── Backfill missing candles ─────────────────────────────
async function backfillCandles(id, lastCandleTime, lastPrice) {
  const now         = Math.floor(Date.now() / 1000);
  const candleSec   = CANDLE_MS / 1000;

  // কতো candle missing
  const firstMissing = lastCandleTime + candleSec;
  const lastMissing  = Math.floor(now / candleSec) * candleSec - candleSec;
  const missingCount = Math.floor((lastMissing - lastCandleTime) / candleSec);

  if (missingCount <= 0) return lastPrice;

  // সর্বোচ্চ ৪৮০ candle backfill (৮ ঘন্টা) — বেশি হলে skip
  const toFill = Math.min(missingCount, 480);
  console.log(`[${id}] Backfilling ${toFill} missing candles...`);

  let price = lastPrice;
  let trend = 0;
  let trendSteps = 0;

  for (let i = 0; i < toFill; i++) {
    const candleTime = firstMissing + (i * candleSec);

    // Trend update
    if (trendSteps <= 0) {
      const r = Math.random();
      trend = r < 0.38 ? 1 : r < 0.76 ? -1 : 0;
      trendSteps = 8 + Math.floor(Math.random() * 12);
    }
    trendSteps--;

    // Generate candle ticks (120 ticks per candle)
    let open = price, high = price, low = price;
    for (let t = 0; t < 120; t++) {
      const volatility = price * 0.0008;
      const trendBias  = trend * volatility * 0.4;
      const noise      = (Math.random() - 0.5) * volatility * 2;
      price = Math.max(price + trendBias + noise, 0.0001);
      if (price > high) high = price;
      if (price < low)  low  = price;
    }

    const candle = { time: candleTime, open, high, low, close: price };
    await saveCandle(id, candle);
  }

  console.log(`[${id}] Backfill complete. Last price: $${price.toFixed(4)}`);
  return price;
}

// ── Initialize one symbol ────────────────────────────────
async function initSymbol(market) {
  const { id, baseSymbol } = market;

  // Last candle Firebase থেকে নাও
  const lastCandle = await loadLastCandle(id, baseSymbol);

  let startPrice;
  const now        = Date.now();
  const candleSec  = CANDLE_MS / 1000;
  const nowSec     = Math.floor(now / 1000);

  if (lastCandle) {
    const lastTime   = lastCandle.time;
    const currentBoundary = Math.floor(nowSec / candleSec) * candleSec;
    const gapCandles = Math.floor((currentBoundary - lastTime) / candleSec) - 1;

    if (gapCandles > 0) {
      // Gap আছে — backfill করো
      startPrice = await backfillCandles(id, lastTime, lastCandle.close);
    } else {
      startPrice = lastCandle.close;
      console.log(`[${id}] Resumed from Firebase @ $${startPrice}`);
    }
  } else {
    // Firebase এ কিছু নেই — Binance থেকে নাও
    startPrice = await fetchRealPrice(baseSymbol);
    if (!startPrice || startPrice <= 0) startPrice = 100;
    console.log(`[${id}] Starting fresh from Binance @ $${startPrice}`);
  }

  const candleStart = Math.floor(now / CANDLE_MS) * CANDLE_MS;

  _states[id] = {
    price:       startPrice,
    candleOpen:  startPrice,
    candleHigh:  startPrice,
    candleLow:   startPrice,
    candleTime:  candleStart / 1000,
    nextCandle:  candleStart + CANDLE_MS,
    trend:       0,
    trendSteps:  0,
  };
}

// ── Tick one symbol ──────────────────────────────────────
async function tick(id) {
  const state = _states[id];
  if (!state) return;

  const now = Date.now();

  // Trend update
  if (state.trendSteps <= 0) {
    state.trend      = randomTrend();
    state.trendSteps = 8 + Math.floor(Math.random() * 12);
  }
  state.trendSteps--;

  // Price movement
  const volatility = state.price * 0.0008;
  const trendBias  = state.trend * volatility * 0.4;
  const noise      = (Math.random() - 0.5) * volatility * 2;
  state.price      = Math.max(state.price + trendBias + noise, 0.0001);

  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  // Live candle Firebase এ লেখো — সব client এটা পড়বে
  const liveCandle = {
    time:  state.candleTime,
    open:  state.candleOpen,
    high:  state.candleHigh,
    low:   state.candleLow,
    close: state.price
  };
  set(ref(db, `otc_candles/${id}/live`), liveCandle).catch(() => {});

  // Candle close
  if (now >= state.nextCandle) {
    const closed = {
      time:  state.candleTime,
      open:  state.candleOpen,
      high:  state.candleHigh,
      low:   state.candleLow,
      close: state.price
    };
    await saveCandle(id, closed);

    state.candleTime  = state.nextCandle / 1000;
    state.candleOpen  = state.price;
    state.candleHigh  = state.price;
    state.candleLow   = state.price;
    state.nextCandle += CANDLE_MS;
  }
}

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('OTC Server starting...');

  // সব symbol initialize করো
  for (const market of OTC_MARKETS) {
    await initSymbol(market);
  }

  console.log('All OTC engines initialized. Ticking...');

  // Tick loop — প্রতি 500ms
  setInterval(() => {
    OTC_MARKETS.forEach(m => tick(m.id));
  }, TICK_MS);
}

main().catch(console.error);

// Render এ process alive রাখার জন্য HTTP server
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OTC Worker Running');
}).listen(process.env.PORT || 3000, () => {
  console.log('HTTP server listening on port', process.env.PORT || 3000);
});

// ── Self-ping — Render sleep prevent করার জন্য ──────────
// প্রতি 14 মিনিটে নিজেকে ping করে — server জেগে থাকে
setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/')
    .then(() => console.log('[keepalive] self-ping OK'))
    .catch(e => console.warn('[keepalive] ping failed:', e.message));
}, 14 * 60 * 1000);
