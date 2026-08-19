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
const { validateStakeAmount, validateProfitGoal } = require('./settings');
const supervisor = require('./supervisor-core');

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

    const text = message.text.trim();
    if (text.startsWith('/')) {
      await handleCommand(text);
    } else {
      // Not a slash command - the only thing free text can mean is an
      // answer to a question the supervisor (telegram-supervisor.js)
      // asked. If nothing is pending, it's just noise.
      await handleFreeText(text);
    }
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
    case '/dailygoal':
      return handleDailyGoal(args[0]);
    case '/weeklygoal':
      return handleWeeklyGoal(args[0]);
    case '/ask':
      return handleAsk(args.join(' '));
    case '/help':
      return handleHelp();
    default:
      return telegram.sendMessage(`Unknown command: ${command}\nSend /help for the list of commands.`);
  }
}

// A message that isn't a /command - the only thing it can meaningfully
// be is a reply to a question the supervisor asked. If nothing is
// pending, say so rather than silently discarding it.
async function handleFreeText(text) {
  const result = await supervisor.answerPendingQuestion(text);
  if (!result.handled) {
    return telegram.sendMessage(
      "I don't have a pending question to answer. Send /help for commands, or /ask <question> to ask me something."
    );
  }
}

// User-initiated call into the LLM supervisor - always calls through
// (no skip-check, the user explicitly asked), and always replies:
// the supervisor's system prompt instructs it to answer directly
// rather than choosing "none" when the trigger is a user_ask.
async function handleAsk(question) {
  if (!question) {
    return telegram.sendMessage('Usage: /ask <question>');
  }
  await memory.appendSupervisorConversation('user', question);
  const result = await supervisor.runSupervisorCycle('user_ask', question);
  if (result && result.skipped && result.reason === 'not_configured') {
    return telegram.sendMessage("Supervisor isn't configured yet (missing ANTHROPIC_API_KEY).");
  }
  if (result && result.error) {
    return telegram.sendMessage(`⚠ Supervisor couldn't answer: ${result.error}`);
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
  const weeklyState = await memory.loadWeeklyState(strategyName);
  const activeTrade = await memory.getActiveTrade(strategyName);
  const lastTrade = await memory.getLastTrade(strategyName);

  const netProfit = state.dailyProfit - state.dailyLoss;
  const weeklyNet = weeklyState.weeklyProfit - weeklyState.weeklyLoss;
  const winRate = state.tradesToday > 0 ? (state.wins / state.tradesToday) * 100 : 0;

  let statusLine;
  if (state.manualPause) statusLine = '⏸ STOPPED (manual)';
  else if (state.paused) statusLine = '⏸ COOLDOWN';
  else statusLine = '▶ RUNNING';

  let text = `${statusLine}\nStrategy: <b>${strategyName}</b>\n` +
    `Net P&amp;L today: ${netProfit >= 0 ? '+' : '-'}$${Math.abs(netProfit).toFixed(2)}\n` +
    `Weekly P&amp;L: ${weeklyNet >= 0 ? '+' : '-'}$${Math.abs(weeklyNet).toFixed(2)} / $${settings.weeklyProfitGoal} goal\n` +
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

  if (data.startsWith('strategy:')) {
    const strategyName = data.slice('strategy:'.length);
    const result = await switchStrategy(strategyName);
    if (!result.ok) {
      return telegram.answerCallbackQuery(cq.id, `❌ ${result.error}`);
    }
    await telegram.answerCallbackQuery(cq.id, `✅ Switched to ${STRATEGY_LABELS[strategyName] || strategyName}`);
    return telegram.sendMessage(`✅ Strategy set to <b>${strategyName}</b> - takes effect on the next scheduled run.`);
  }

  // A Yes/No tap on a change the supervisor proposed (supervisor-core.js).
  // Approving re-validates against CURRENT settings and applies through
  // the same memory.js writes every other Telegram command uses - the
  // supervisor itself never writes settings without this human tap.
  if (data.startsWith('approve:')) {
    const id = data.slice('approve:'.length);
    const result = await supervisor.applyPendingApproval(id);
    if (!result.ok) {
      await telegram.answerCallbackQuery(cq.id, result.alreadyResolved ? 'Already resolved.' : `❌ ${result.error || 'Could not apply.'}`);
      return result.stale ? telegram.sendMessage(`❌ That proposal no longer applies: ${result.error}`) : undefined;
    }
    await telegram.answerCallbackQuery(cq.id, '✅ Applied');
    return telegram.sendMessage(`✅ Applied: <b>${result.kind}</b> → ${result.value}`);
  }

  if (data.startsWith('deny:')) {
    const id = data.slice('deny:'.length);
    const result = await supervisor.denyPendingApproval(id);
    if (!result.ok) {
      return telegram.answerCallbackQuery(cq.id, 'Already resolved.');
    }
    await telegram.answerCallbackQuery(cq.id, 'Discarded');
    return telegram.sendMessage('❌ Proposal discarded.');
  }

  return telegram.answerCallbackQuery(cq.id, '');
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

async function handleDailyGoal(arg) {
  const settings = await memory.loadSettings();

  if (!arg) {
    return telegram.sendMessage(`Current daily profit goal: $${settings.dailyProfitGoal}\nSend /dailygoal &lt;amount&gt; to change it.`);
  }

  const validated = validateProfitGoal(arg);
  if (!validated.ok) {
    return telegram.sendMessage(`❌ ${validated.error}`);
  }

  const saved = await memory.saveSettings({ dailyProfitGoal: validated.value });
  await memory.appendLog(saved.activeStrategy, `Daily profit goal changed to $${validated.value.toFixed(2)} via Telegram`, 'info');
  return telegram.sendMessage(`✅ Daily profit goal set to $${validated.value.toFixed(2)} - takes effect on the next scheduled run.`);
}

async function handleWeeklyGoal(arg) {
  const settings = await memory.loadSettings();

  if (!arg) {
    return telegram.sendMessage(`Current weekly profit goal: $${settings.weeklyProfitGoal}\nSend /weeklygoal &lt;amount&gt; to change it.`);
  }

  const validated = validateProfitGoal(arg);
  if (!validated.ok) {
    return telegram.sendMessage(`❌ ${validated.error}`);
  }

  const saved = await memory.saveSettings({ weeklyProfitGoal: validated.value });
  await memory.appendLog(saved.activeStrategy, `Weekly profit goal changed to $${validated.value.toFixed(2)} via Telegram`, 'info');
  return telegram.sendMessage(`✅ Weekly profit goal set to $${validated.value.toFixed(2)} - takes effect on the next scheduled run.`);
}

async function handleHelp() {
  return telegram.sendMessage(
    '<b>Commands</b>\n' +
    '/start - resume trading\n' +
    '/stop - pause trading\n' +
    '/status - current status, P&amp;L, active trade\n' +
    '/strategy [accumulator|digit_differ|hybrid] - view/switch strategy, or send with no argument for tappable buttons\n' +
    '/stake [amount] - view or change stake\n' +
    '/dailygoal [amount] - view or change daily profit goal\n' +
    '/weeklygoal [amount] - view or change weekly profit goal\n' +
    '/ask <question> - ask the LLM supervisor anything about how the bot is doing\n' +
    '/help - this message\n\n' +
    'The supervisor also checks in on its own and may send a report, a question (reply in plain text to answer), or a proposed settings change (tap Approve/Deny).'
  );
}
