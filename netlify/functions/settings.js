// settings.js
// GET returns current settings (symbol, stake, indicator periods, risk
// rules). POST updates them. driver.js and risk.js both read these via
// memory.loadSettings() on every run, so changes take effect on the
// NEXT scheduled run, not instantly.

const memory = require('./memory');

const ALLOWED_SYMBOLS = ['R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V'];

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
      if (body.activeStrategy === 'rise_fall' || body.activeStrategy === 'digit') {
        update.activeStrategy = body.activeStrategy;
      }
      if (body.digitLookback && body.digitLookback >= 10 && body.digitLookback <= 100) {
        update.digitLookback = parseInt(body.digitLookback);
      }

      // Risk rules - validate ranges before anything else, since stake
      // validation below depends on the resulting dailyStopLoss.
      if (body.dailyProfitGoal && body.dailyProfitGoal > 0) {
        update.dailyProfitGoal = parseFloat(body.dailyProfitGoal);
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

      // Stake validation - a single trade shouldn't be able to eat more
      // than 20% of whatever the daily stop loss ends up being (using the
      // NEW value if the user is changing it in this same request).
      const effectiveStopLoss = update.dailyStopLoss || current.dailyStopLoss;
      const maxStake = effectiveStopLoss * 0.2;

      if (body.stakeAmount) {
        const stake = parseFloat(body.stakeAmount);
        if (stake <= 0) {
          return respond({ error: 'Stake must be greater than 0' });
        }
        if (stake > maxStake) {
          return respond({
            error: `Stake of $${stake.toFixed(2)} rejected - with a $${effectiveStopLoss} daily stop loss, a single trade shouldn't risk more than $${maxStake.toFixed(2)} (20% of that).`
          });
        }
        update.stakeAmount = stake;
      }

      if (body.emaFastPeriod && body.emaFastPeriod > 0) update.emaFastPeriod = parseInt(body.emaFastPeriod);
      if (body.emaSlowPeriod && body.emaSlowPeriod > 0) update.emaSlowPeriod = parseInt(body.emaSlowPeriod);
      if (body.rsiPeriod && body.rsiPeriod > 0) update.rsiPeriod = parseInt(body.rsiPeriod);
      if (body.rsiOverbought && body.rsiOverbought > 50 && body.rsiOverbought <= 100) update.rsiOverbought = parseInt(body.rsiOverbought);
      if (body.rsiOversold && body.rsiOversold >= 0 && body.rsiOversold < 50) update.rsiOversold = parseInt(body.rsiOversold);
      if (typeof body.requireRsiConfirmation === 'boolean') update.requireRsiConfirmation = body.requireRsiConfirmation;

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
