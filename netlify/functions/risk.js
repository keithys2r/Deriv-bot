// risk.js
// Decides whether the bot is ALLOWED to place a trade right now.
// Reads state from memory.js, never writes trade outcomes itself —
// memory.js owns writing. risk.js only reads + decides + can set pause.

const memory = require('./memory');

// ---- Your risk rules live here, change these numbers as you like ----
const DAILY_PROFIT_GOAL = 20;      // stop trading for the day once hit
const DAILY_STOP_LOSS = 15;        // stop trading for the day once hit
const MAX_CONSECUTIVE_LOSSES = 3;  // triggers a cooldown pause
const COOLDOWN_MINUTES = 15;       // how long the pause lasts
// ------------------------------------------------------------------

// Returns { canTrade: boolean, reason: string, state: {...} }
async function checkCanTrade(strategyName) {
  const state = await memory.loadState(strategyName);
  const now = new Date();

  // 0. Manual pause - user hit STOP on the frontend, overrides everything else
  if (state.manualPause) {
    return {
      canTrade: false,
      reason: 'Manually paused by user (STOP button)',
      state
    };
  }

  // 1. Check if currently in a cooldown pause
  if (state.paused && state.pausedUntil) {
    const pausedUntil = new Date(state.pausedUntil);
    if (now < pausedUntil) {
      return {
        canTrade: false,
        reason: `Paused until ${pausedUntil.toISOString()} (cooldown after ${MAX_CONSECUTIVE_LOSSES} losses)`,
        state
      };
    } else {
      // Cooldown expired, clear the pause
      state.paused = false;
      state.pausedUntil = null;
      await memory.saveState(strategyName, state);
    }
  }

  // 2. Check daily profit goal
  if (state.dailyProfit >= DAILY_PROFIT_GOAL) {
    return {
      canTrade: false,
      reason: `Daily profit goal hit ($${state.dailyProfit.toFixed(2)} >= $${DAILY_PROFIT_GOAL})`,
      state
    };
  }

  // 3. Check daily stop loss
  if (state.dailyLoss >= DAILY_STOP_LOSS) {
    return {
      canTrade: false,
      reason: `Daily stop loss hit ($${state.dailyLoss.toFixed(2)} >= $${DAILY_STOP_LOSS})`,
      state
    };
  }

  // 4. Check consecutive losses -> trigger new cooldown
  if (state.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
    const pausedUntil = new Date(now.getTime() + COOLDOWN_MINUTES * 60 * 1000);
    state.paused = true;
    state.pausedUntil = pausedUntil.toISOString();
    await memory.saveState(strategyName, state);
    return {
      canTrade: false,
      reason: `${MAX_CONSECUTIVE_LOSSES} consecutive losses hit -> cooldown started until ${pausedUntil.toISOString()}`,
      state
    };
  }

  // All checks passed
  return {
    canTrade: true,
    reason: 'All risk checks passed',
    state
  };
}

module.exports = {
  checkCanTrade,
  DAILY_PROFIT_GOAL,
  DAILY_STOP_LOSS,
  MAX_CONSECUTIVE_LOSSES,
  COOLDOWN_MINUTES
};
