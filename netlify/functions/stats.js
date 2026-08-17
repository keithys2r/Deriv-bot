// stats.js
// Read-only endpoint exposing real performance analysis from PERSISTENT
// trade history - not the rolling 30-entry display log. Answers "when
// does this bot actually perform best" (by hour, by regime, by symbol).

const memory = require('./memory');

exports.handler = async function (event) {
  try {
    const params = event.queryStringParameters || {};
    const settings = await memory.loadSettings();
    const strategyName = params.strategy || settings.activeStrategy || 'rise_fall';

    const stats = await memory.computeStats(strategyName);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ strategy: strategyName, ...stats })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
