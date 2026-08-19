// balance.js
// On-demand endpoint - the frontend calls this directly (not through
// driver.js) to show live account balance. Separate from the trading
// loop so checking your balance never slows down or interferes with
// actual trade execution.

const { getOtpWebSocketUrl } = require('./deriv-auth');

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    return respond({ error: 'No token configured' });
  }

  try {
    const auth = await getOtpWebSocketUrl(token, app_id);
    const balanceData = await connectAndGetBalance(auth.wsUrl);

    return respond({
      balance: balanceData.balance,
      currency: balanceData.currency,
      loginid: balanceData.loginid,
      accountType: auth.account.account_type
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

function connectAndGetBalance(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for balance'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ balance: 1 }));
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

      if (res.msg_type === 'balance') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve({
          balance: res.balance.balance,
          currency: res.balance.currency,
          loginid: res.balance.loginid
        });
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('WS Error: ' + err.message));
      }
    };
  });
}
