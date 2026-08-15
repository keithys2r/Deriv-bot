// telegram.js
// One-way alerts: bot -> you. No commands, no webhook, no 2-way yet.
// Uses Telegram's HTTP API directly (no npm package needed, avoids
// the same bundling issues you hit with the ws package).

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Low-level sender. Every alert function below calls this.
async function sendMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram not configured, skipping alert:', text);
    return { skipped: true };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
      })
    });
    const data = await response.json();
    if (!data.ok) {
      console.log('Telegram send failed:', data.description);
    }
    return data;
  } catch (err) {
    console.log('Telegram error:', err.message);
    return { error: err.message };
  }
}

// ---- Specific alert types you asked for ----

async function alertBotStarted(strategyName) {
  return sendMessage(`🤖 Bot started\nStrategy: <b>${strategyName}</b>`);
}

async function alertPaused(strategyName, reason) {
  return sendMessage(`⏸ Paused\nStrategy: <b>${strategyName}</b>\nReason: ${reason}`);
}

async function alertDailyGoalHit(strategyName, profit) {
  return sendMessage(`✅ Daily goal hit!\nStrategy: <b>${strategyName}</b>\nProfit: $${profit.toFixed(2)}`);
}

async function alertStopLossHit(strategyName, loss) {
  return sendMessage(`🛑 Daily stop loss hit\nStrategy: <b>${strategyName}</b>\nLoss: $${loss.toFixed(2)}`);
}

async function alertEODReport(strategyName, state) {
  const winRate = state.tradesToday > 0
    ? ((state.wins / state.tradesToday) * 100).toFixed(1)
    : '0.0';

  return sendMessage(
    `📊 End of Day Report\n` +
    `Strategy: <b>${strategyName}</b>\n` +
    `Trades: ${state.tradesToday}\n` +
    `Wins: ${state.wins} | Losses: ${state.losses}\n` +
    `Win rate: ${winRate}%\n` +
    `Profit: $${state.dailyProfit.toFixed(2)}\n` +
    `Loss: $${state.dailyLoss.toFixed(2)}\n` +
    `Net: $${(state.dailyProfit - state.dailyLoss).toFixed(2)}`
  );
}

module.exports = {
  sendMessage,
  alertBotStarted,
  alertPaused,
  alertDailyGoalHit,
  alertStopLossHit,
  alertEODReport
};
