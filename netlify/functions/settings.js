// settings.js
// GET returns current settings (symbol, stake, indicator periods, risk
// rules). POST updates them. driver.js and risk.js both read these via
// memory.loadSettings() on every run, so changes take effect on the
// NEXT scheduled run, not instantly.

const memory = require('./memory');

const ALLOWED_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];
const ACCUMULATOR_GROWTH_RATES = [0.01, 0.02, 0.03, 0.04, 0.05]; // Deriv's allowed discrete growth rates
const VALID_STRATEGIES = ['accumulator', 'digit_differ', 'hybrid'];

// Shared with telegram-webhook.js, so a stake change via Telegram is
// held to exactly the same 20%-of-stop-loss rule as one made from the
// dashboard, instead of two copies of this rule silently drifting apart.
function validateStakeAmount(rawStake, dailyStopLoss) {
  const stake = parseFloat(rawStake);
  if (!Number.isFinite(stake) || stake <= 0) {
    return { ok: false, error: 'Stake must be greater than 0' };
  }
  const maxStake = dailyStopLoss * 0.2;
  if (stake > maxStake) {
    return {
      ok: false,
      error: `Stake of $${stake.toFixed(2)} rejected - with a $${dailyStopLoss} daily stop loss, a single trade shouldn't risk more than $${maxStake.toFixed(2)} (20% of that).`
    };
  }
  return { ok: true, value: stake };
}

module.exports.validateStakeAmount = validateStakeAmount;
module.exports.ALLOWED_SYMBOLS = ALLOWED_SYMBOLS;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const settings = await memory.loadSettings();
      return respond({ settings, allowedSymbols: ALLOWED_SYMBOLS });
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const current = await memory.loadSettings();
      const update = {};

      if (body.symbol && ALLOWED_SYMBOLS.includes(body.symbol)) update.symbol = body.symbol;
      if (typeof body.autoSelectSymbol === 'boolean') update.autoSelectSymbol = body.autoSelectSymbol;
      if (Array.isArray(body.watchlist)) {
        const validWatchlist = body.watchlist.filter((s) => ALLOWED_SYMBOLS.includes(s));
        if (validWatchlist.length === 3) {
          update.watchlist = validWatchlist;
        } else if (validWatchlist.length > 0) {
          return respond({ error: `Watchlist needs exactly 3 valid symbols, got ${validWatchlist.length}.` });
        }
      }
      if (VALID_STRATEGIES.includes(body.activeStrategy)) {
        update.activeStrategy = body.activeStrategy;
      }

      // Risk rules - validate ranges before anything else, since stake
      // validation below depends on the resulting dailyStopLoss.
      if (body.dailyProfitGoal && body.dailyProfitGoal > 0) {
        update.dailyProfitGoal = parseFloat(body.dailyProfitGoal);
      }
      if (body.weeklyProfitGoal && body.weeklyProfitGoal > 0) {
        update.weeklyProfitGoal = parseFloat(body.weeklyProfitGoal);
      }
      if (body.dailyStopLoss && body.dailyStopLoss > 0) {
        update.dailyStopLoss = parseFloat(body.dailyStopLoss);
      }
      if (body.maxConsecutiveLosses && body.maxConsecutiveLosses >= 1) {
        update.maxConsecutiveLosses = parseInt(body.maxConsecutiveLosses);
      }
      if (body.cooldownMinutes && body.cooldownMinutes >= 1) {
        update.cooldownMinutes = parseInt(body.cooldownMinutes);
      }
      if (typeof body.cooldownEnabled === 'boolean') update.cooldownEnabled = body.cooldownEnabled;

      // Stake validation - a single trade shouldn't be able to eat more
      // than 20% of whatever the daily stop loss ends up being (using the
      // NEW value if the user is changing it in this same request).
      const effectiveStopLoss = update.dailyStopLoss || current.dailyStopLoss;

      if (body.stakeAmount) {
        const validated = validateStakeAmount(body.stakeAmount, effectiveStopLoss);
        if (!validated.ok) {
          return respond({ error: validated.error });
        }
        update.stakeAmount = validated.value;
      }

      if (body.candleGranularitySeconds && body.candleGranularitySeconds >= 5 && body.candleGranularitySeconds <= 60) {
        update.candleGranularitySeconds = parseInt(body.candleGranularitySeconds);
      }
      if (body.adxPeriod && body.adxPeriod >= 2 && body.adxPeriod <= 50) update.adxPeriod = parseInt(body.adxPeriod);

      if (body.digitDifferExcludeCount !== undefined && body.digitDifferExcludeCount >= 1 && body.digitDifferExcludeCount <= 9) {
        update.digitDifferExcludeCount = parseInt(body.digitDifferExcludeCount);
      }

      if (body.accumulatorGrowthRate !== undefined && ACCUMULATOR_GROWTH_RATES.includes(body.accumulatorGrowthRate)) {
        update.accumulatorGrowthRate = body.accumulatorGrowthRate;
      }
      if (body.accumulatorTakeProfitPct !== undefined && body.accumulatorTakeProfitPct >= 0.01 && body.accumulatorTakeProfitPct <= 1.0) {
        update.accumulatorTakeProfitPct = parseFloat(body.accumulatorTakeProfitPct);
      }
      if (body.accumulatorTakeProfitTicks !== undefined && body.accumulatorTakeProfitTicks >= 0 && body.accumulatorTakeProfitTicks <= 20) {
        update.accumulatorTakeProfitTicks = parseInt(body.accumulatorTakeProfitTicks);
      }
      if (body.accumulatorAdxMaxEntry !== undefined && body.accumulatorAdxMaxEntry >= 5 && body.accumulatorAdxMaxEntry <= 50) {
        update.accumulatorAdxMaxEntry = parseInt(body.accumulatorAdxMaxEntry);
      }
      if (body.accumulatorMaxHoldMinutes !== undefined && body.accumulatorMaxHoldMinutes >= 1 && body.accumulatorMaxHoldMinutes <= 60) {
        update.accumulatorMaxHoldMinutes = parseInt(body.accumulatorMaxHoldMinutes);
      }

      const saved = await memory.saveSettings(update);
      await memory.appendLog(saved.activeStrategy, `Settings updated: ${Object.keys(update).join(', ')}`, 'info');

      return respond({ settings: saved });
    }

    return respond({ error: 'Method not allowed' });
  } catch (err) {
    return respond({ error: err.message });
  }
};

function respond(body) {
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}
