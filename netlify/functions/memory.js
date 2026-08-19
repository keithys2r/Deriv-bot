// memory.js
// Handles saving/loading bot state (P&L, win rate, losses, pause state)
// Uses Netlify Blobs so data survives function restarts.
// Each strategy gets its own memory "slot" so Accumulator and Rise/Fall don't mix.

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
    consecutiveWins: 0,    // current win streak, resets on any loss
    longestWinStreak: 0,   // best win streak reached today
    recentEvents: [], // rolling log for the frontend, newest first, capped at 30
    stopLossAlertSent: false, // prevents re-alerting the same stop-loss hit every run
    goalAlertSent: false,     // same, for daily profit goal
    consecutiveApiFailures: 0, // consecutive driver.js runs that errored out - trips the kill switch
    killSwitchAlertSent: false, // prevents re-alerting every run once the kill switch has already paused the bot
    lastUpdated: new Date().toISOString()
  };
}

// Load state for a given strategy ("accumulator", "digit_differ", "hybrid")
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
  // consecutiveApiFailures/killSwitchAlertSent also carry over - a failure streak spanning
  // the UTC day boundary is still the same ongoing problem, not a fresh one.
  if (existing.date !== today) {
    const fresh = defaultState();
    fresh.manualPause = existing.manualPause || false;
    fresh.consecutiveApiFailures = existing.consecutiveApiFailures || 0;
    fresh.killSwitchAlertSent = existing.killSwitchAlertSent || false;
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
    state.consecutiveWins = (state.consecutiveWins || 0) + 1;
    if (state.consecutiveWins > (state.longestWinStreak || 0)) {
      state.longestWinStreak = state.consecutiveWins;
    }
  } else {
    state.losses += 1;
    state.dailyLoss += Math.abs(safeProfitOrLoss);
    state.consecutiveLosses += 1;
    state.consecutiveWins = 0;
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

const API_FAILURE_KILL_SWITCH = 5; // consecutive failed runs before auto-pausing

// Called from driver.js's top-level catch on every failed run. Returns
// the updated state (not just the count) so the caller can decide
// whether to trip the kill switch and persist manualPause/alert flags
// on that same object without loading state a second time.
async function recordApiFailure(strategyName) {
  const state = await loadState(strategyName);
  state.consecutiveApiFailures = (state.consecutiveApiFailures || 0) + 1;
  await saveState(strategyName, state);
  return state;
}

// Called on any successful run - clears the streak so a single blip
// doesn't linger toward the kill switch threshold indefinitely.
async function recordApiSuccess(strategyName) {
  const state = await loadState(strategyName);
  if (state.consecutiveApiFailures > 0 || state.killSwitchAlertSent) {
    state.consecutiveApiFailures = 0;
    state.killSwitchAlertSent = false;
    await saveState(strategyName, state);
  }
}

const ERROR_LOG_MAX = 30; // same cap as recentEvents, kept separate so real
                           // errors don't get buried under routine info/win/loss lines

// Persistent (well, capped-rolling) error log, separate from appendLog's
// recentEvents - that list mixes routine trade activity with failures,
// which buries the signal a human actually needs to see quickly.
async function appendErrorLog(strategyName, message) {
  const store = getMemoryStore();
  const key = `error_log_${strategyName}`;
  let errorLog;
  try {
    errorLog = await store.get(key, { type: 'json' });
  } catch (e) {
    errorLog = null;
  }
  errorLog = errorLog || [];
  errorLog.unshift({ time: new Date().toISOString(), message });
  errorLog = errorLog.slice(0, ERROR_LOG_MAX);
  await store.setJSON(key, errorLog);
  return errorLog;
}

async function getErrorLog(strategyName) {
  const store = getMemoryStore();
  try {
    const errorLog = await store.get(`error_log_${strategyName}`, { type: 'json' });
    return errorLog || [];
  } catch (e) {
    return [];
  }
}

// Settings are stored separately from strategy state - these are user-
// configured values (symbol, indicator periods) that don't reset daily.
const SETTINGS_KEY = 'bot_settings';

function defaultSettings() {
  return {
    activeStrategy: 'accumulator', // 'accumulator' | 'digit_differ' | 'hybrid' - the switch
    symbol: 'R_100',
    autoSelectSymbol: false,
    watchlist: ['R_100', 'R_75', 'R_50'],
    stakeAmount: 1,
    candleGranularitySeconds: 15, // custom candle size built from raw ticks - Deriv's native minimum is 60s
    adxPeriod: 14,
    accumulatorGrowthRate: 0.01,   // 1% - the safest/lowest of Deriv's allowed growth rates, wider knockout barrier
    accumulatorTakeProfitPct: 0.05, // cash out once profit reaches 5% of stake
    accumulatorTakeProfitTicks: 0,  // 0 = disabled, use accumulatorTakeProfitPct directly.
                                     // >0 = derive take-profit from this many ticks of
                                     // growth at the current growth rate instead - trades
                                     // win size for a higher chance of cashing out before
                                     // a knockout (see strategy_accumulator.ticksToTakeProfitPct)
    accumulatorAdxMaxEntry: 20,    // only enter when ADX is at/below this (calm/ranging market) -
                                     // also the ADX ceiling hybrid uses to route to accumulator
    accumulatorMaxHoldMinutes: 10, // safety backstop: force-sell if still open this long
    digitDifferExcludeCount: 2,    // how many digits (0-9) to exclude per trade - win probability
                                     // is exactly (excludeCount/10), fixed by the contract itself,
                                     // not by any market read (see strategy_digit_differ.js)
    dailyProfitGoal: 20,
    dailyStopLoss: 15,
    weeklyProfitGoal: 100,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 15,
    cooldownEnabled: true
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

const LOCK_KEY = 'execution_lock';
const LOCK_TIMEOUT_MS = 25000; // if a lock is older than this, assume the holder crashed/died and allow a new run

// Prevents two invocations from running the trade logic at the same
// time - important because Netlify can retry a scheduled function that
// runs too long, and an overlapping run could place a duplicate trade
// or race with the original run's state writes.
async function acquireLock() {
  const store = getMemoryStore();
  const existing = await store.get(LOCK_KEY, { type: 'json', consistency: 'strong' });

  if (existing && existing.lockedAt) {
    const age = Date.now() - new Date(existing.lockedAt).getTime();
    if (age < LOCK_TIMEOUT_MS) {
      return false; // another invocation is very likely still running
    }
  }

  // The installed @netlify/blobs client has no conditional/compare-and-swap
  // write (set() takes no onlyIfNew/onlyIfMatch option), so true atomicity
  // isn't available - narrow the race instead: write a unique token, then
  // read the key back with strong consistency. If two invocations race here,
  // both writes land but only one is the actual last write; both readers
  // then see that SAME value, so only the invocation whose token matches
  // proceeds, and the other correctly backs off instead of both trading.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await store.setJSON(LOCK_KEY, { lockedAt: new Date().toISOString(), token });
  const confirm = await store.get(LOCK_KEY, { type: 'json', consistency: 'strong' });
  return !!confirm && confirm.token === token;
}

async function releaseLock() {
  const store = getMemoryStore();
  try {
    await store.delete(LOCK_KEY);
  } catch (e) {
    // already clear, ignore
  }
}

const TRADE_HISTORY_MAX = 5000; // caps storage size, still covers weeks of data

// Records a full structured trade record to PERSISTENT history - unlike
// recentEvents (capped at 30, just for the live display), this keeps
// growing (up to TRADE_HISTORY_MAX) so real performance analysis is
// possible later: which hours/regimes/symbols actually perform best.
async function recordTradeHistory(strategyName, record) {
  const store = getMemoryStore();
  const key = `trade_history_${strategyName}`;
  let history;
  try {
    history = await store.get(key, { type: 'json' });
  } catch (e) {
    history = null;
  }
  history = history || [];

  history.push({
    time: record.time || new Date().toISOString(),
    hour: record.hour !== undefined ? record.hour : new Date().getUTCHours(),
    symbol: record.symbol,
    strategy: strategyName,
    regime: record.regime || null,
    direction: record.direction,
    stake: record.stake,
    won: record.won,
    profit: record.profit,
    exitReason: record.exitReason || null, // accumulator only: 'take_profit' | 'knockout' | 'timeout'
    holdSeconds: record.holdSeconds !== undefined ? record.holdSeconds : null, // accumulator only
    subStrategy: record.subStrategy || null // hybrid only: 'digit_differ' | 'accumulator' - which style hybrid picked for this trade
  });

  if (history.length > TRADE_HISTORY_MAX) {
    history = history.slice(history.length - TRADE_HISTORY_MAX);
  }

  await store.setJSON(key, history);
  return history;
}

async function getTradeHistory(strategyName) {
  const store = getMemoryStore();
  try {
    const history = await store.get(`trade_history_${strategyName}`, { type: 'json' });
    return history || [];
  } catch (e) {
    return [];
  }
}

// Aggregates the full trade history into win rate by hour, by regime,
// and by symbol - the actual "when does this bot perform best" answer.
async function computeStats(strategyName) {
  const history = await getTradeHistory(strategyName);

  const byHour = {}; // hour (0-23) -> { wins, losses, profit }
  const byRegime = {}; // 'trend' | 'range' -> { wins, losses, profit }
  const bySymbol = {}; // symbol -> { wins, losses, profit }
  const byExitReason = {}; // accumulator only: 'take_profit' | 'knockout' | 'timeout' -> { wins, losses, profit }
  const bySubStrategy = {}; // hybrid only: 'digit_differ' | 'accumulator' -> { wins, losses, profit }

  let totalWins = 0;
  let totalLosses = 0;
  let totalProfit = 0;
  let holdSecondsSum = 0;
  let holdSecondsCount = 0;

  history.forEach((t) => {
    const hourKey = t.hour;
    const regimeKey = t.regime || 'n/a';
    const symbolKey = t.symbol || 'unknown';

    if (!byHour[hourKey]) byHour[hourKey] = { wins: 0, losses: 0, profit: 0 };
    if (!byRegime[regimeKey]) byRegime[regimeKey] = { wins: 0, losses: 0, profit: 0 };
    if (!bySymbol[symbolKey]) bySymbol[symbolKey] = { wins: 0, losses: 0, profit: 0 };

    const p = Number.isFinite(t.profit) ? t.profit : 0;

    if (t.exitReason) {
      if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { wins: 0, losses: 0, profit: 0 };
      if (t.won) byExitReason[t.exitReason].wins++;
      else byExitReason[t.exitReason].losses++;
      byExitReason[t.exitReason].profit += p;
    }

    if (Number.isFinite(t.holdSeconds)) {
      holdSecondsSum += t.holdSeconds;
      holdSecondsCount++;
    }

    if (t.subStrategy) {
      if (!bySubStrategy[t.subStrategy]) bySubStrategy[t.subStrategy] = { wins: 0, losses: 0, profit: 0 };
      if (t.won) bySubStrategy[t.subStrategy].wins++;
      else bySubStrategy[t.subStrategy].losses++;
      bySubStrategy[t.subStrategy].profit += p;
    }

    if (t.won) {
      byHour[hourKey].wins++;
      byRegime[regimeKey].wins++;
      bySymbol[symbolKey].wins++;
      totalWins++;
    } else {
      byHour[hourKey].losses++;
      byRegime[regimeKey].losses++;
      bySymbol[symbolKey].losses++;
      totalLosses++;
    }

    byHour[hourKey].profit += p;
    byRegime[regimeKey].profit += p;
    bySymbol[symbolKey].profit += p;
    totalProfit += p;
  });

  function withWinRate(obj) {
    const result = {};
    Object.keys(obj).forEach((k) => {
      const total = obj[k].wins + obj[k].losses;
      result[k] = {
        wins: obj[k].wins,
        losses: obj[k].losses,
        trades: total,
        winRate: total > 0 ? (obj[k].wins / total) * 100 : 0,
        profit: obj[k].profit
      };
    });
    return result;
  }

  return {
    totalTrades: history.length,
    totalWins,
    totalLosses,
    totalWinRate: (totalWins + totalLosses) > 0 ? (totalWins / (totalWins + totalLosses)) * 100 : 0,
    totalProfit,
    avgHoldSeconds: holdSecondsCount > 0 ? holdSecondsSum / holdSecondsCount : null,
    byHour: withWinRate(byHour),
    byRegime: withWinRate(byRegime),
    bySymbol: withWinRate(bySymbol),
    byExitReason: withWinRate(byExitReason),
    bySubStrategy: withWinRate(bySubStrategy)
  };
}

// ---- Weekly profit tracking (separate from daily state) ----
// Powers the "de-risk as you approach your weekly target" feature -
// stake scales DOWN as you get closer to the goal, protecting gains
// already made rather than pushing harder to close it out.

function getWeekStartUTC(date) {
  const d = date || new Date();
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1; // days since most recent Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMonday));
  return monday.toISOString().slice(0, 10);
}

async function loadWeeklyState(strategyName) {
  const store = getMemoryStore();
  const key = `weekly_state_${strategyName}`;
  const existing = await store.get(key, { type: 'json' });
  const currentWeekStart = getWeekStartUTC();

  if (!existing || existing.weekStart !== currentWeekStart) {
    return { weekStart: currentWeekStart, weeklyProfit: 0, weeklyLoss: 0 };
  }
  return existing;
}

async function saveWeeklyState(strategyName, state) {
  const store = getMemoryStore();
  await store.setJSON(`weekly_state_${strategyName}`, state);
}

async function recordWeeklyTrade(strategyName, { won, profitOrLoss }) {
  const state = await loadWeeklyState(strategyName);
  const safeProfitOrLoss = Number.isFinite(profitOrLoss) ? profitOrLoss : 0;

  if (won) {
    state.weeklyProfit += safeProfitOrLoss;
  } else {
    state.weeklyLoss += Math.abs(safeProfitOrLoss);
  }

  if (!Number.isFinite(state.weeklyProfit)) state.weeklyProfit = 0;
  if (!Number.isFinite(state.weeklyLoss)) state.weeklyLoss = 0;

  await saveWeeklyState(strategyName, state);
  return state;
}

// Returns a multiplier (1.0, 0.75, 0.5) applied to stake based on how
// close weekly net profit is to the weekly goal - never scales UP,
// only ever protects gains by sizing down as the target nears.
function getStakeScaleFactor(weeklyNetProfit, weeklyProfitGoal) {
  if (!weeklyProfitGoal || weeklyProfitGoal <= 0) return 1.0;
  const progress = weeklyNetProfit / weeklyProfitGoal;
  if (progress >= 0.8) return 0.5;
  if (progress >= 0.5) return 0.75;
  return 1.0;
}

// Graduated stake reduction as a losing streak builds, so the bot backs
// off smoothly instead of trading full-size right up until risk.js's
// cooldown slams it to zero. Reduction ramps linearly to a 50% cut by
// the time consecutiveLosses reaches maxConsecutiveLosses - the same
// point risk.js fully pauses trading - so sizing and pausing converge
// at the same threshold instead of disagreeing. Floors at 0.5x even if
// cooldownEnabled is off and the streak keeps growing past that point.
const MAX_LOSING_STREAK_REDUCTION = 0.5;
function getLosingStreakScaleFactor(consecutiveLosses, maxConsecutiveLosses) {
  if (!consecutiveLosses || consecutiveLosses <= 0) return 1.0;
  if (!maxConsecutiveLosses || maxConsecutiveLosses <= 0) return 1.0;
  const cappedLosses = Math.min(consecutiveLosses, maxConsecutiveLosses);
  const reduction = (cappedLosses / maxConsecutiveLosses) * MAX_LOSING_STREAK_REDUCTION;
  return 1.0 - reduction;
}

// Scales stake by signal confidence (0-1) - only ever scales DOWN from
// base, same philosophy as the weekly/losing-streak factors. A
// low-confidence signal already cleared whatever floor/threshold gated
// it into firing at all, so it doesn't deserve a hard cutoff - a linear
// floor-to-1.0 ramp means confidence 0 trades at half size, confidence 1
// trades at full size. No current strategy produces a confidence score
// (kept as an optional no-op hook for a future one that does) - passing
// undefined returns a no-op 1.0.
const MIN_CONFIDENCE_FACTOR = 0.5;
function getConfidenceScaleFactor(confidence) {
  if (confidence === undefined || confidence === null || !Number.isFinite(confidence)) return 1.0;
  const c = Math.max(0, Math.min(1, confidence));
  return MIN_CONFIDENCE_FACTOR + c * (1 - MIN_CONFIDENCE_FACTOR);
}

module.exports = {
  loadState,
  saveState,
  recordTrade,
  defaultState,
  appendLog,
  setManualPause,
  recordApiFailure,
  recordApiSuccess,
  appendErrorLog,
  getErrorLog,
  API_FAILURE_KILL_SWITCH,
  loadSettings,
  saveSettings,
  defaultSettings,
  setActiveTrade,
  clearActiveTrade,
  getActiveTrade,
  setLastTrade,
  getLastTrade,
  acquireLock,
  releaseLock,
  recordTradeHistory,
  getTradeHistory,
  computeStats,
  getWeekStartUTC,
  loadWeeklyState,
  saveWeeklyState,
  recordWeeklyTrade,
  getStakeScaleFactor,
  getLosingStreakScaleFactor,
  getConfidenceScaleFactor
};
