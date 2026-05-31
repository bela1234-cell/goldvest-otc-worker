// ============================================================
// otc-server.js — OTC Candle Generator Server
// Render.com এ 24/7 চলবে।
// প্রতি মিনিটে সব OTC symbol এর candle generate করে Firebase এ save করে।
// ============================================================

const { initializeApp } = require('firebase/app');
const { getDatabase, ref, push, set, get, onValue, query, orderByKey, limitToLast } = require('firebase/database');

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
  // Crypto OTC
  { id: 'BTCOTC',     baseSymbol: 'BTCUSDT', startPrice: 0      },
  { id: 'ETHOTC',     baseSymbol: 'ETHUSDT', startPrice: 0      },
  { id: 'BNBOTC',     baseSymbol: 'BNBUSDT', startPrice: 0      },
  { id: 'SOLOTC',     baseSymbol: 'SOLUSDT', startPrice: 0      },

  // USDT/BDT
  { id: 'USDTBDT',    baseSymbol: null,       startPrice: 110.50 },

  // Currencies OTC
  { id: 'EURUSDOTC',  baseSymbol: null,       startPrice: 1.085  },
  { id: 'GBPUSDOTC',  baseSymbol: null,       startPrice: 1.265  },
  { id: 'USDJPYOTC',  baseSymbol: null,       startPrice: 157.50 },
  { id: 'AUDUSDOTC',  baseSymbol: null,       startPrice: 0.645  },
  { id: 'USDCADOTC',  baseSymbol: null,       startPrice: 1.365  },
  { id: 'EURGBPOTC',  baseSymbol: null,       startPrice: 0.858  },

  // Commodities OTC
  { id: 'XAUUSDOTC',  baseSymbol: null,       startPrice: 2320.0 },
  { id: 'XAGUSDOTC',  baseSymbol: null,       startPrice: 27.50  },
  { id: 'WTICRUDOTC', baseSymbol: null,       startPrice: 78.50  },
];

// ── OTC Admin Controls cache (per symbol) ────────────────
const _controls = {};

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
async function loadLastCandle(id) {
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
  const now         = Math.floor(Date.now() / 1000);
  const candleSec   = CANDLE_MS / 1000;
  const firstMissing = lastCandleTime + candleSec;
  const lastMissing  = Math.floor(now / candleSec) * candleSec - candleSec;
  const missingCount = Math.floor((lastMissing - lastCandleTime) / candleSec);

  if (missingCount <= 0) return lastPrice;

  const toFill = Math.min(missingCount, 480);
  console.log(`[${id}] Backfilling ${toFill} missing candles...`);

  let price = lastPrice;
  let trend = 0;
  let trendSteps = 0;

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
    const candle = { time: candleTime, open, high, low, close: price };
    await saveCandle(id, candle);
  }

  console.log(`[${id}] Backfill complete. Last price: $${price.toFixed(4)}`);
  return price;
}

// ── Initialize one symbol ────────────────────────────────
async function initSymbol(market) {
  const { id, baseSymbol, startPrice: fixedStart } = market;

  const lastCandle = await loadLastCandle(id);

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

  const now  = Date.now();
  const ctrl = _controls[id] || {};

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
    if (dir === 'up')        state.trend = 1;
    else if (dir === 'down') state.trend = -1;
    else                     state.trend = 0;
    state.trendSteps = 99;
  } else if (ctrl.mode === 'trade-based') {
    if (state.trendSteps <= 0) {
      state.trendSteps = 8 + Math.floor(Math.random() * 8);
    }
    state.trendSteps--;
  }

  const volatility = state.price * 0.0008 * volMul;
  const trendBias  = state.trend * volatility * trendStr;
  const noise      = (Math.random() - 0.5) * volatility * 2;
  state.price      = Math.max(state.price + (trendBias + noise) * speed, 0.0001);

  if (state.price > state.candleHigh) state.candleHigh = state.price;
  if (state.price < state.candleLow)  state.candleLow  = state.price;

  if (now >= state.nextCandle) {
    const closed = {
      time:  state.candleTime,
      open:  state.candleOpen,
      high:  state.candleHigh,
      low:   state.candleLow,
      close: state.price
    };
    await saveCandle(id, closed);

    try {
      set(ref(db, `otc_candles/${id}/live`), null).catch(() => {});
    } catch (e) {}

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

// ── Main ─────────────────────────────────────────────────
async function main() {
  console.log('OTC Server starting...');
  for (const market of OTC_MARKETS) {
    await initSymbol(market);
  }
  console.log('All OTC engines initialized. Ticking...');
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

// ── Self-ping ────────────────────────────────────────────
setInterval(() => {
  fetch('https://goldvest-otc-worker.onrender.com/')
    .then(() => console.log('[keepalive] self-ping OK'))
    .catch(e => console.warn('[keepalive] ping failed:', e.message));
}, 14 * 60 * 1000);
