// Logger - saves trades (for now in logs, next we link Google Sheets)

exports.handler = async function(event) {
  const trade = event.queryStringParameters || { result: "test", profit: 0 };

  console.log("TRADE LOGGED:", trade);

  return {
    statusCode: 200,
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      message: `📝 Logged: ${trade.result} | Profit: $${trade.profit}`,
      timestamp: new Date().toISOString()
    })
  };
};
