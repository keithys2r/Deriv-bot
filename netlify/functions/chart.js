// chart.js
// On-demand endpoint - frontend polls this to draw a REAL candlestick
// chart. Separate from driver.js's trading loop, uses whatever symbol
// is currently selected in settings.js.

const { getOtpWebSocketUrl } = require('./deriv-auth');
const memory = require('./memory');

const CANDLE_GRANULARITY = 60; // 1-minute candles
const CANDLE_COUNT = 40; // how many candles to show on the chart

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    return respond({ error: 'No token configured' });
  }

  try {
    const settings = await memory.loadSettings();
    const auth = await getOtpWebSocketUrl(token, app_id);
    const candles = await connectAndGetCandles(auth.wsUrl, settings.symbol);

    return respond({
      symbol: settings.symbol,
      candles: candles.map((c) => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        epoch: c.epoch
      }))
    });
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

function connectAndGetCandles(wsUrl, symbol) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for candle history'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'candles',
        granularity: CANDLE_GRANULARITY,
        count: CANDLE_COUNT,
        end: 'latest'
      }));
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);

      if (res.error) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        reject(new Error(res.error.message));
        return;
      }

      if (res.msg_type === 'candles') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(res.candles || (res.data && res.data.candles) || []);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error('WS Error: ' + err.message));
      }
    };
  });
}
