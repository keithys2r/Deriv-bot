// control.js
// Handles START/STOP button clicks from the frontend.
// Sets the manualPause flag that risk.js checks before every trade.

const memory = require('./memory');

exports.handler = async function (event) {
  // Browsers send an OPTIONS preflight before a POST with a JSON body
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action; // 'start' or 'stop'

    if (action !== 'start' && action !== 'stop') {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: "action must be 'start' or 'stop'" })
      };
    }

    const paused = action === 'stop';
    const state = await memory.setManualPause('rise_fall', paused);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: `Bot ${paused ? 'stopped' : 'started'}`, manualPause: state.manualPause })
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
