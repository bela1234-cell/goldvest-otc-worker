// ============================================================
// otc-server.js — OTC Candle Generator Server
// Render.com এ 24/7 চলবে।
// প্রতি মিনিটে সব OTC symbol এর candle generate করে Firebase এ save করে।
// ============================================================

const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, query, orderByKey, limitToLast, get } = require('firebase/database');

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

// ── Load last saved price from Firebase ─────────────────
async function loadLastPrice(id, baseSymbol) {
  try {
    const r    = ref(db, `otc_candles/${id}/candles`);
    const q    = query(r, orderByKey(), limitToLast(1));
    const snap = await get(q);
    if (snap.exists()) {
      const vals = Object.values(snap.val());
      console.log(`[${id}] Resumed from Firebase @ $${vals[0].close}`);
      return vals[0].close;
    }
  } catch (e) {}
  const p = await fetchRealPrice(baseSymbol);
  console.log(`[${id}] Starting fresh from Binance @ $${p}`);
  return p > 0 ? p : 100;
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

// ── Initialize one symbol ────────────────────────────────
async function initSymbol(market) {
  const { id, baseSymbol } = market;
  const startPrice = await loadLastPrice(id, baseSymbol);

  const now         = Date.now();
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
