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
  const cooldownEnabled = settings.cooldownEnabled !== false;
  const testModeEnabled = settings.testModeEnabled === true;

  // 0. Manual pause - user hit STOP on the frontend, overrides everything else
  if (state.manualPause) {
    return {
      canTrade: false,
      reason: 'Manually paused by user (STOP button)',
      state
    };
  }

  // 1. Check if currently in a cooldown pause - skipped entirely if the
  // user has turned the cooldown feature off, including clearing any
  // pause that was already active when they flipped the switch.
  if (cooldownEnabled && state.paused && state.pausedUntil) {
    const pausedUntil = new Date(state.pausedUntil);
    if (now < pausedUntil) {
      return {
        canTrade: false,
        reason: `Paused until ${pausedUntil.toISOString()} (cooldown after ${maxConsecutiveLosses} losses)`,
        state
      };
    } else {
      // Cooldown has been served - give a genuine clean slate. Without
      // resetting consecutiveLosses here, the very next signal would
      // immediately re-trigger another cooldown (since that counter only
      // resets on a WIN), permanently locking the bot out of trading
      // again after just one loss streak.
      state.paused = false;
      state.pausedUntil = null;
      state.consecutiveLosses = 0;
      await memory.saveState(strategyName, state);
    }
  } else if (!cooldownEnabled && state.paused) {
    // Cooldown feature turned off while a pause was active - clear it
    // immediately instead of leaving a stale pause the bot can never escape.
    state.paused = false;
    state.pausedUntil = null;
    state.consecutiveLosses = 0;
    await memory.saveState(strategyName, state);
  }

  // 2/2b/3 are all skipped in test mode - manualPause and the
  // consecutive-loss cooldown (checks 0/1/4) still apply, this only
  // disables the "stop while ahead/behind" checks so a deliberate test
  // run (e.g. comparing session performance) isn't cut short partway
  // through by a goal or stop-loss hit.
  if (!testModeEnabled) {
    // 2. Check daily profit goal - based on NET profit (wins minus
    // losses), matching what's actually happened to the account. Checking
    // gross wins alone would let this trigger even while net flat or down,
    // since losses were never subtracted from that number.
    const netProfit = state.dailyProfit - state.dailyLoss;
    if (netProfit >= dailyProfitGoal) {
      return {
        canTrade: false,
        reason: `Daily profit goal hit ($${netProfit.toFixed(2)} net >= $${dailyProfitGoal})`,
        state
      };
    }

    // 2b. Weekly profit goal - once fully hit, pause for the rest of the
    // week rather than keep pushing. Same "stop while ahead" logic as the
    // daily goal, just at a longer horizon.
    const weeklyState = await memory.loadWeeklyState(strategyName);
    const weeklyNet = weeklyState.weeklyProfit - weeklyState.weeklyLoss;
    const weeklyProfitGoal = settings.weeklyProfitGoal;
    if (weeklyProfitGoal && weeklyNet >= weeklyProfitGoal) {
      return {
        canTrade: false,
        reason: `Weekly profit goal hit ($${weeklyNet.toFixed(2)} net >= $${weeklyProfitGoal}) - paused until next week`,
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
  }

  // 4. Check consecutive losses -> trigger new cooldown (only if enabled)
  if (cooldownEnabled && state.consecutiveLosses >= maxConsecutiveLosses) {
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
