// test-telegram.js
// TEMPORARY test function - hit its URL once to confirm your Telegram
// bot token + chat ID are wired up correctly. Delete this file once
// confirmed working, it's not part of the real bot flow.

const telegram = require('./telegram');

exports.handler = async function () {
  const results = {};

  results.testMessage = await telegram.sendMessage('🧪 Test message - if you see this, Telegram alerts are working!');
  results.botStarted = await telegram.alertBotStarted('rise_fall');
  results.paused = await telegram.alertPaused('rise_fall', 'Test pause reason - 3 consecutive losses');
  results.goalHit = await telegram.alertDailyGoalHit('rise_fall', 20.50);
  results.stopLoss = await telegram.alertStopLossHit('rise_fall', 15.25);
  results.eodReport = await telegram.alertEODReport('rise_fall', {
    tradesToday: 8,
    wins: 5,
    losses: 3,
    dailyProfit: 12.40,
    dailyLoss: 6.80
  });

  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({
      message: 'Sent 6 test alerts to Telegram - check your chat',
      results
    })
  };
};
