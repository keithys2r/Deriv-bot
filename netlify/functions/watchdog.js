// Watchdog - stops trading if loss limit hit

let dailyLoss = 0;
const MAX_LOSS = 10; // $10 max loss per day for demo

exports.handler = async function() {
  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      dailyLoss: dailyLoss,
      maxLoss: MAX_LOSS,
      canTrade: dailyLoss < MAX_LOSS,
      message: dailyLoss >= MAX_LOSS ? "⛔ STOP - Loss limit hit!" : "✅ Safe to trade"
    })
  };
};
