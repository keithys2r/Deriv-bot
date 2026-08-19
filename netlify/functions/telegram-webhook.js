// telegram-webhook.js
// On-demand endpoint - Telegram POSTs here (as a registered webhook)
// whenever a message is sent to the bot, turning the previously one-way
// alert channel (telegram.js) into a two-way remote control: start/stop,
// status, switching strategy, and adjusting stake, all from Telegram
// instead of needing the dashboard open.
//
// SECURITY: the only thing stopping a stranger who finds the bot's
// username from controlling a live trading bot is that every command
// is checked against TELEGRAM_CHAT_ID (the same env var telegram.js
// already sends alerts to) - a message from any other chat is ignored.
// This is a deliberate substitute for the dashboard's own missing auth
// (control.js/settings.js still have none) until that's addressed.
//
// SETUP: this function does nothing until you register it as your bot's
// webhook - Telegram doesn't do this automatically. After deploying,
// run once (replace <TOKEN> with your real bot token - never commit it
// anywhere): https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR-SITE.netlify.app/.netlify/functions/telegram-webhook

const memory = require('./memory');
const telegram = require('./telegram');
const { validateStakeAmount } = require('./settings');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

exports.handler = async function (event) {
  // Telegram only ever POSTs here. Anything else (a stray GET from a
  // browser, etc.) gets a plain 200 so it doesn't look like a live,
  // pokeable endpoint worth investigating further.
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'ok' };
  }

  try {
    const update = JSON.parse(event.body || '{}');
    const message = update.message;
    const callbackQuery = update.callback_query;

    // A tapped inline-keyboard button arrives as callback_query, not a
    // text message - handle it separately (still gated by the same
    // chat-id check below).
    if (callbackQuery && callbackQuery.message && callbackQuery.message.chat) {
      if (!TELEGRAM_CHAT_ID || String(callbackQuery.message.chat.id) !== String(TELEGRAM_CHAT_ID)) {
        console.log(`Ignored Telegram callback from unrecognized chat ${callbackQuery.message.chat.id}`);
        return { statusCode: 200, body: 'ok' };
      }
      if (!TELEGRAM_TOKEN) {
        return { statusCode: 200, body: 'ok' };
      }
      await handleCallbackQuery(callbackQuery);
      return { statusCode: 200, body: 'ok' };
    }

    // Not a text message (e.g. an edited_message, a sticker) - nothing
    // to do, but still 200 so Telegram doesn't keep retrying delivery.
    if (!message || !message.text || !message.chat) {
      return { statusCode: 200, body: 'ok' };
    }

    // The real access-control boundary - see the file header. Reject
    // silently (no reply at all) so a stranger probing the bot gets no
    // confirmation it even exists, let alone that a command landed.
    if (!TELEGRAM_CHAT_ID || String(message.chat.id) !== String(TELEGRAM_CHAT_ID)) {
      console.log(`Ignored Telegram message from unrecognized chat ${message.chat.id}`);
      return { statusCode: 200, body: 'ok' };
    }

    if (!TELEGRAM_TOKEN) {
      // Configured chat ID but no token means alerts/replies can't be
      // sent either way - nothing useful this function can do.
      return { statusCode: 200, body: 'ok' };
    }

    await handleCommand(message.text.trim());
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.log('telegram-webhook.js error:', err.message);
    // Still 200 - a non-200 makes Telegram retry delivery of the same
    // update repeatedly, which would just repeat whatever broke.
    return { statusCode: 200, body: 'ok' };
  }
};

async function handleCommand(rawText) {
  // Group-chat commands arrive as "/stop@YourBotName" - strip the
  // suffix so this works the same in a private chat or a group.
  const [rawCommand, ...args] = rawText.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();

  switch (command) {
    case '/start':
      return handleStartStop(false);
    case '/stop':
      return handleStartStop(true);
    case '/status':
      return handleStatus();
    case '/strategy':
      return handleStrategy(args[0]);
    case '/stake':
      return handleStake(args[0]);
    case '/help':
      return handleHelp();
    default:
      return telegram.sendMessage(`Unknown command: ${command}\nSend /help for the list of commands.`);
  }
}

async function handleStartStop(paused) {
  const settings = await memory.loadSettings();
  const strategyName = settings.activeStrategy || 'accumulator';
  await memory.setManualPause(strategyName, paused);
  return telegram.sendMessage(`${paused ? '⏸ Stopped' : '✅ Started'} (strategy: <b>${strategyName}</b>)`);
}

async function handleStatus() {
  const settings = await memory.loadSettings();
  const strategyName = settings.activeStrategy || 'accumulator';
  const state = await memory.loadState(strategyName);
  const activeTrade = await memory.getActiveTrade(strategyName);
  const lastTrade = await memory.getLastTrade(strategyName);

  const netProfit = state.dailyProfit - state.dailyLoss;
  const winRate = state.tradesToday > 0 ? (state.wins / state.tradesToday) * 100 : 0;

  let statusLine;
  if (state.manualPause) statusLine = '⏸ STOPPED (manual)';
  else if (state.paused) statusLine = '⏸ COOLDOWN';
  else statusLine = '▶ RUNNING';

  let text = `${statusLine}\nStrategy: <b>${strategyName}</b>\n` +
    `Net P&amp;L today: ${netProfit >= 0 ? '+' : '-'}$${Math.abs(netProfit).toFixed(2)}\n` +
    `Trades: ${state.tradesToday} (${state.wins}W/${state.losses}L, ${winRate.toFixed(0)}%)\n` +
    `Stake: $${settings.stakeAmount}`;

  if (activeTrade) {
    text += `\n\n⏳ Active trade: ${activeTrade.direction} on ${activeTrade.symbol} - $${activeTrade.stake.toFixed(2)}`;
  } else if (lastTrade) {
    text += `\n\nLast trade: ${lastTrade.direction} on ${lastTrade.symbol} - ${lastTrade.won ? 'WON' : 'LOST'} $${Math.abs(lastTrade.profit).toFixed(2)}`;
  }

  return telegram.sendMessage(text);
}

const VALID_STRATEGIES = ['accumulator', 'digit_differ', 'hybrid'];
const STRATEGY_LABELS = { accumulator: 'Accumulator', digit_differ: 'Digit Differ', hybrid: 'Hybrid' };

// Shared by the typed "/strategy <name>" path and the button-tap path
// below, so there's one source of truth for the actual switch.
async function switchStrategy(strategyName) {
  if (!VALID_STRATEGIES.includes(strategyName)) {
    return { ok: false, error: `Strategy must be one of: ${VALID_STRATEGIES.join(', ')}.` };
  }
  const saved = await memory.saveSettings({ activeStrategy: strategyName });
  await memory.appendLog(saved.activeStrategy, 'Strategy switched via Telegram', 'info');
  return { ok: true };
}

async function handleStrategy(arg) {
  if (!arg) {
    const settings = await memory.loadSettings();
    const buttons = VALID_STRATEGIES.map((name) => ([{ text: STRATEGY_LABELS[name], callback_data: `strategy:${name}` }]));
    return telegram.sendMessage(
      `Current strategy: <b>${settings.activeStrategy || 'accumulator'}</b>\nTap to switch:`,
      { inline_keyboard: buttons }
    );
  }

  const strategyName = arg.toLowerCase();
  const result = await switchStrategy(strategyName);
  if (!result.ok) {
    return telegram.sendMessage(`❌ ${result.error}`);
  }
  return telegram.sendMessage(`✅ Strategy set to <b>${strategyName}</b> - takes effect on the next scheduled run.`);
}

async function handleCallbackQuery(cq) {
  const data = cq.data || '';
  if (!data.startsWith('strategy:')) {
    return telegram.answerCallbackQuery(cq.id, '');
  }

  const strategyName = data.slice('strategy:'.length);
  const result = await switchStrategy(strategyName);
  if (!result.ok) {
    return telegram.answerCallbackQuery(cq.id, `❌ ${result.error}`);
  }

  await telegram.answerCallbackQuery(cq.id, `✅ Switched to ${STRATEGY_LABELS[strategyName] || strategyName}`);
  return telegram.sendMessage(`✅ Strategy set to <b>${strategyName}</b> - takes effect on the next scheduled run.`);
}

async function handleStake(arg) {
  const settings = await memory.loadSettings();

  if (!arg) {
    return telegram.sendMessage(`Current stake: $${settings.stakeAmount}\nSend /stake &lt;amount&gt; to change it.`);
  }

  const validated = validateStakeAmount(arg, settings.dailyStopLoss);
  if (!validated.ok) {
    return telegram.sendMessage(`❌ ${validated.error}`);
  }

  const saved = await memory.saveSettings({ stakeAmount: validated.value });
  await memory.appendLog(saved.activeStrategy, `Stake changed to $${validated.value.toFixed(2)} via Telegram`, 'info');
  return telegram.sendMessage(`✅ Stake set to $${validated.value.toFixed(2)} - takes effect on the next scheduled run.`);
}

async function handleHelp() {
  return telegram.sendMessage(
    '<b>Commands</b>\n' +
    '/start - resume trading\n' +
    '/stop - pause trading\n' +
    '/status - current status, P&amp;L, active trade\n' +
    '/strategy [accumulator|digit_differ|hybrid] - view/switch strategy, or send with no argument for tappable buttons\n' +
    '/stake [amount] - view or change stake\n' +
    '/help - this message'
  );
}
