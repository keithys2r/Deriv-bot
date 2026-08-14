const WebSocket = require('ws');

exports.handler = async function() {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ message: "❌ No DERIV_TOKEN found in Netlify env vars" }) };
  }

  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (data) => {
      const res = JSON.parse(data);

      // 1. Authorized successfully
      if (res.msg_type === 'authorize') {
        console.log("Authorized:", res.authorize.loginid);
        // Now get balance
        ws.send(JSON.stringify({ balance: 1, subscribe: 1 }));
      }

      // 2. Got balance = WE ARE LIVE
      if (res.msg_type === 'balance') {
        const balance = res.balance.balance;
        const account = res.balance.loginid;
        ws.close();
        resolve({
          statusCode: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            message: `🚀 LIVE! Connected to ${account} | Balance: $${balance}`,
            balance: balance,
            account: account
          })
        });
      }

      if (res.error) {
        ws.close();
        resolve({
          statusCode: 400,
          body: JSON.stringify({ message: `Deriv Error: ${res.error.message}` })
        });
      }
    });

    ws.on('error', (err) => {
      resolve({ statusCode: 500, body: JSON.stringify({ message: "WS Error: " + err.message }) });
    });

    // Timeout safety
    setTimeout(() => {
      try{ ws.close(); } catch(e){}
      resolve({ statusCode: 504, body: JSON.stringify({ message: "Timeout connecting to Deriv" }) });
    }, 8000);
  });
};
