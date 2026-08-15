// settings.js
// GET returns current settings (symbol, stake, indicator periods).
// POST updates them. driver.js reads these via memory.loadSettings()
// on every run, so changes take effect on the NEXT scheduled run,
// not instantly.

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
      const update = {};

      // Only accept known fields, with basic sanity checks - never trust
      // raw input straight into storage.
      if (body.symbol && ALLOWED_SYMBOLS.includes(body.symbol)) update.symbol = body.symbol;
      if (body.stakeAmount && body.stakeAmount > 0) update.stakeAmount = parseFloat(body.stakeAmount);
      if (body.emaFastPeriod && body.emaFastPeriod > 0) update.emaFastPeriod = parseInt(body.emaFastPeriod);
      if (body.emaSlowPeriod && body.emaSlowPeriod > 0) update.emaSlowPeriod = parseInt(body.emaSlowPeriod);
      if (body.rsiPeriod && body.rsiPeriod > 0) update.rsiPeriod = parseInt(body.rsiPeriod);
      if (body.rsiOverbought && body.rsiOverbought > 50 && body.rsiOverbought <= 100) update.rsiOverbought = parseInt(body.rsiOverbought);
      if (body.rsiOversold && body.rsiOversold >= 0 && body.rsiOversold < 50) update.rsiOversold = parseInt(body.rsiOversold);

      const saved = await memory.saveSettings(update);
      await memory.appendLog('rise_fall', `Settings updated: ${Object.keys(update).join(', ')}`, 'info');

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
