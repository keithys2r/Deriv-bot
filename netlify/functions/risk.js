// risk.js
// Decides whether the bot is ALLOWED to place a trade right now.
// Reads BOTH state (from memory.js) and user-configured settings
// (profit goal, stop loss, max losses, cooldown) - these are no longer
// hardcoded, the user sets them from the dashboard Settings panel.

const memory = require('./memory');

// Returns { canTrade: boolean, reason: string, state: {...} }
async function checkCanTrade(strategyName) {
  const state = await memory.loadState(strategyName);
  const settings = await memory.loadSettings();
  const now = new Date();

  const dailyProfitGoal = settings.dailyProfitGoal;
  const dailyStopLoss = settings.dailyStopLoss;
  const maxConsecutiveLosses = settings.maxConsecutiveLosses;
  const cooldownMinutes = settings.cooldownMinutes;

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
        reason: `Paused until ${pausedUntil.toISOString()} (cooldown after ${maxConsecutiveLosses} losses)`,
        state
      };
    } else {
      state.paused = false;
      state.pausedUntil = null;
      await memory.saveState(strategyName, state);
    }
  }

  // 2. Check daily profit goal
  if (state.dailyProfit >= dailyProfitGoal) {
    return {
      canTrade: false,
      reason: `Daily profit goal hit ($${state.dailyProfit.toFixed(2)} >= $${dailyProfitGoal})`,
      state
    };
  }

  // 3. Check daily stop loss
  if (state.dailyLoss >= dailyStopLoss) {
    return {
      canTrade: false,
      reason: `Daily stop loss hit ($${state.dailyLoss.toFixed(2)} >= $${dailyStopLoss})`,
      state
    };
  }

  // 4. Check consecutive losses -> trigger new cooldown
  if (state.consecutiveLosses >= maxConsecutiveLosses) {
    const pausedUntil = new Date(now.getTime() + cooldownMinutes * 60 * 1000);
    state.paused = true;
    state.pausedUntil = pausedUntil.toISOString();
    await memory.saveState(strategyName, state);
    return {
      canTrade: false,
      reason: `${maxConsecutiveLosses} consecutive losses hit -> cooldown started until ${pausedUntil.toISOString()}`,
      state
    };
  }

  return {
    canTrade: true,
    reason: 'All risk checks passed',
    state
  };
}

module.exports = {
  checkCanTrade
};
