// memory.js
// Handles saving/loading bot state (P&L, win rate, losses, pause state)
// Uses Netlify Blobs so data survives function restarts.
// Each strategy gets its own memory "slot" so Digit and Rise/Fall don't mix.

const { getStore } = require('@netlify/blobs');

// One store for all bot memory, keyed by strategy name inside it.
// Explicitly passing siteID + token because scheduled functions don't
// always get Netlify's automatic Blobs context the way normal
// request-triggered functions do.
function getMemoryStore() {
  return getStore({
    name: 'bot-memory',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_AUTH_TOKEN
  });
}

// Default shape for a brand new day / brand new strategy
function defaultState() {
  return {
    date: new Date().toISOString().slice(0, 10), // "2026-08-15"
    dailyProfit: 0,
    dailyLoss: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    paused: false,
    pausedUntil: null, // timestamp string, null if not paused
    manualPause: false, // true when the user hits STOP on the frontend
    tradesToday: 0,
    lastTradeResult: null, // "win" | "loss" | null
    recentEvents: [], // rolling log for the frontend, newest first, capped at 30
    stopLossAlertSent: false, // prevents re-alerting the same stop-loss hit every run
    goalAlertSent: false,     // same, for daily profit goal
    regime: 'range',          // current market regime for adaptive rise/fall: 'trend' | 'range'
    regimeTrendCount: 0,      // consecutive candles ADX has stayed above the trend threshold
    regimeRangeCount: 0,      // consecutive candles ADX has stayed below the range threshold
    lastUpdated: new Date().toISOString()
  };
}

// Load state for a given strategy ("digit_over_under" or "rise_fall")
// If nothing saved yet, or it's a new day, returns a fresh default state.
async function loadState(strategyName) {
  const store = getMemoryStore();
  const key = `state_${strategyName}`;
  const existing = await store.get(key, { type: 'json' });

  const today = new Date().toISOString().slice(0, 10);

  if (!existing) {
    return defaultState();
  }

  // New day detected -> reset daily counters but keep the strategy's identity clean.
  // manualPause carries over - if the user hit STOP, a new day shouldn't silently resume trading.
  if (existing.date !== today) {
    const fresh = defaultState();
    fresh.manualPause = existing.manualPause || false;
    return fresh;
  }

  return existing;
}

// Save state for a given strategy
async function saveState(strategyName, state) {
  const store = getMemoryStore();
  const key = `state_${strategyName}`;
  state.lastUpdated = new Date().toISOString();
  await store.setJSON(key, state);
  return state;
}

// Convenience: record the outcome of a trade and persist it
async function recordTrade(strategyName, { won, profitOrLoss, stake }) {
  const state = await loadState(strategyName);

  // Guard against a bad/missing profit value corrupting the running
  // total. JSON silently turns NaN into null on save, which then
  // displays as a false "$0.00" instead of surfacing the error - so
  // catch it here instead and log it loudly.
  const safeProfitOrLoss = Number.isFinite(profitOrLoss) ? profitOrLoss : 0;
  if (!Number.isFinite(profitOrLoss)) {
    console.log(`WARNING: recordTrade got a non-numeric profitOrLoss (${profitOrLoss}) for ${strategyName} - treating as $0, but this trade's real result was NOT counted in P&L.`);
  }

  state.tradesToday += 1;
  state.lastTradeResult = won ? 'win' : 'loss';

  if (won) {
    state.wins += 1;
    state.dailyProfit += safeProfitOrLoss;
    state.consecutiveLosses = 0;
  } else {
    state.losses += 1;
    state.dailyLoss += Math.abs(safeProfitOrLoss);
    state.consecutiveLosses += 1;
  }

  // Extra safety net: if dailyProfit/dailyLoss are somehow already
  // NaN from a past corrupted save, reset them rather than let the
  // corruption persist silently forever.
  if (!Number.isFinite(state.dailyProfit)) {
    console.log(`WARNING: state.dailyProfit was corrupted (not a finite number) for ${strategyName}, resetting to 0.`);
    state.dailyProfit = 0;
  }
  if (!Number.isFinite(state.dailyLoss)) {
    console.log(`WARNING: state.dailyLoss was corrupted (not a finite number) for ${strategyName}, resetting to 0.`);
    state.dailyLoss = 0;
  }

  await saveState(strategyName, state);
  return state;
}

// Adds an entry to the rolling event log (for the frontend Live Logs panel).
// Keeps only the most recent 30 events, newest first.
async function appendLog(strategyName, message, level = 'info') {
  const state = await loadState(strategyName);
  state.recentEvents = state.recentEvents || [];
  state.recentEvents.unshift({
    time: new Date().toISOString(),
    message,
    level // 'info' | 'win' | 'loss' | 'pause'
  });
  state.recentEvents = state.recentEvents.slice(0, 30);
  await saveState(strategyName, state);
  return state;
}

// Sets/clears the manual pause flag - called when the user hits START/STOP
// on the frontend. risk.js checks this before allowing any trade.
async function setManualPause(strategyName, paused) {
  const state = await loadState(strategyName);
  state.manualPause = paused;
  await saveState(strategyName, state);
  await appendLog(
    strategyName,
    paused ? 'Bot manually stopped by user' : 'Bot manually started by user',
    'pause'
  );
  return state;
}

// Settings are stored separately from strategy state - these are user-
// configured values (symbol, indicator periods) that don't reset daily.
const SETTINGS_KEY = 'bot_settings';

function defaultSettings() {
  return {
    activeStrategy: 'rise_fall', // 'rise_fall' | 'digit' - the switch
    symbol: 'R_100',
    stakeAmount: 1,
    emaFastPeriod: 9,
    emaSlowPeriod: 21,
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    requireRsiConfirmation: true,
    candleGranularitySeconds: 15, // custom candle size built from raw ticks - Deriv's native minimum is 60s
    useAdaptiveRegime: true, // trend/range switching instead of crossover-only
    adxPeriod: 14,
    adxTrendThreshold: 35, // ADX needs to stay above this to confirm trend regime
    adxRangeThreshold: 25, // ADX needs to stay below this to confirm range regime
    adxFloorTrend: 25,     // minimum ADX required to actually trade in trend regime
    adxFloorRange: 0,      // minimum ADX required to trade in range regime (0 = disabled)
    biasEnabled: true,
    biasPeriod: 20,
    biasThresholdPct: 0.05,
    digitLookback: 20,
    dailyProfitGoal: 20,
    dailyStopLoss: 15,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 15
  };
}

async function loadSettings() {
  const store = getMemoryStore();
  const existing = await store.get(SETTINGS_KEY, { type: 'json' });
  // Merge with defaults so settings saved before new fields existed
  // (like the risk management fields) don't come back as undefined.
  return Object.assign({}, defaultSettings(), existing || {});
}

async function saveSettings(newSettings) {
  const store = getMemoryStore();
  const current = await loadSettings();
  const merged = Object.assign({}, current, newSettings);
  await store.setJSON(SETTINGS_KEY, merged);
  return merged;
}

// Tracks a trade currently in flight (between buy and settlement), so the
// frontend can show "trade in progress" during that brief window.
async function setActiveTrade(strategyName, tradeInfo) {
  const store = getMemoryStore();
  await store.setJSON(`active_trade_${strategyName}`, tradeInfo);
}

async function clearActiveTrade(strategyName) {
  const store = getMemoryStore();
  try {
    await store.delete(`active_trade_${strategyName}`);
  } catch (e) {
    // already clear, ignore
  }
}

async function getActiveTrade(strategyName) {
  const store = getMemoryStore();
  try {
    return await store.get(`active_trade_${strategyName}`, { type: 'json' });
  } catch (e) {
    return null;
  }
}

// Tracks the most recently completed trade, so the frontend always has
// something to show even when no trade is currently in flight.
async function setLastTrade(strategyName, tradeInfo) {
  const store = getMemoryStore();
  await store.setJSON(`last_trade_${strategyName}`, tradeInfo);
}

async function getLastTrade(strategyName) {
  const store = getMemoryStore();
  try {
    return await store.get(`last_trade_${strategyName}`, { type: 'json' });
  } catch (e) {
    return null;
  }
}

// Updates the trend/range regime using hysteresis - needs several
// consecutive candles above/below the ADX thresholds before actually
// switching, so it doesn't flip-flop on every small wiggle. Ported
// from the old bot's regime-switching logic.
async function updateRegime(strategyName, adx, trendThreshold, rangeThreshold, trendConfirmCandles, rangeConfirmCandles) {
  const state = await loadState(strategyName);

  if (adx === null || adx === undefined) {
    return { regime: state.regime || 'range', switched: false };
  }

  if (adx >= trendThreshold) {
    state.regimeTrendCount = (state.regimeTrendCount || 0) + 1;
    state.regimeRangeCount = 0;
  } else if (adx < rangeThreshold) {
    state.regimeRangeCount = (state.regimeRangeCount || 0) + 1;
    state.regimeTrendCount = 0;
  } else {
    state.regimeTrendCount = Math.max(0, (state.regimeTrendCount || 0) - 1);
    state.regimeRangeCount = Math.max(0, (state.regimeRangeCount || 0) - 1);
  }

  const prevRegime = state.regime || 'range';
  let switched = false;

  if (prevRegime === 'range' && state.regimeTrendCount >= trendConfirmCandles) {
    state.regime = 'trend';
    switched = true;
  } else if (prevRegime === 'trend' && state.regimeRangeCount >= rangeConfirmCandles) {
    state.regime = 'range';
    switched = true;
  }

  await saveState(strategyName, state);
  return { regime: state.regime, switched, trendCount: state.regimeTrendCount, rangeCount: state.regimeRangeCount };
}

module.exports = {
  loadState,
  saveState,
  recordTrade,
  defaultState,
  appendLog,
  setManualPause,
  loadSettings,
  saveSettings,
  defaultSettings,
  setActiveTrade,
  clearActiveTrade,
  getActiveTrade,
  setLastTrade,
  getLastTrade,
  updateRegime
};
