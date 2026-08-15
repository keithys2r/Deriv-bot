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

  state.tradesToday += 1;
  state.lastTradeResult = won ? 'win' : 'loss';

  if (won) {
    state.wins += 1;
    state.dailyProfit += profitOrLoss;
    state.consecutiveLosses = 0;
  } else {
    state.losses += 1;
    state.dailyLoss += Math.abs(profitOrLoss);
    state.consecutiveLosses += 1;
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

module.exports = {
  loadState,
  saveState,
  recordTrade,
  defaultState,
  appendLog,
  setManualPause
};
