exports.handler = async function() {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    return { statusCode: 200, body: JSON.stringify({ message: "❌ No token in env vars" }) };
  }

  return new Promise((resolve) => {
    // Use native WebSocket, no npm package needed
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token }));
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);

      if (res.error) {
        ws.close();
        resolve({
          statusCode: 200,
          body: JSON.stringify({ message: `❌ Deriv says: ${res.error.message} - Check your token` })
        });
        return;
      }

      if (res.msg_type === 'authorize') {
        const loginid = res.authorize?.loginid || 'unknown';
        console.log("Authorized:", loginid);
        ws.send(JSON.stringify({ balance: 1 }));
      }

      if (res.msg_type === 'balance') {
        const balance = res.balance?.balance;
        const account = res.balance?.loginid;
        ws.close();
        resolve({
          statusCode: 200,
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({
            message: `🚀 LIVE! ${account} | Balance: $${balance}`,
            balance: balance,
            account: account
          })
        });
      }
    };

    ws.onerror = (err) => {
      resolve({ statusCode: 200, body: JSON.stringify({ message: "WS Error: " + err.message }) });
    };

    setTimeout(() => {
      try { ws.close(); } catch(e){}
      resolve({ statusCode: 200, body: JSON.stringify({ message: "Timeout - Deriv didn't respond" }) });
    }, 7000);
  });
};
