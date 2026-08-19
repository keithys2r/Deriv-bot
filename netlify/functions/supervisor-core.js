// supervisor-core.js
// The LLM-driven "supervisor" logic shared by telegram-supervisor.js (the
// scheduled entry point) and telegram-webhook.js (the /ask command and
// free-text replies to a pending question) - one implementation of the
// call/parse/execute cycle instead of two copies drifting apart, and
// avoids a circular require between the two callers.
//
// Safety model: this module never talks to Deriv and never writes a
// setting on its own. Every settings mutation goes through the exact
// same validators settings.js already exports (validateStakeAmount,
// validateProfitGoal, validateStrategy), re-checked both when a change
// is first proposed AND again when the human taps Approve (settings may
// have changed in between). A malformed or unrecognized model response
// always fails closed to "do nothing" - see parseSupervisorResponse.

const memory = require('./memory');
const telegram = require('./telegram');
const settings = require('./settings');

const ALLOWED_PROPOSAL_KINDS = ['stakeAmount', 'dailyProfitGoal', 'weeklyProfitGoal', 'manualPause', 'activeStrategy'];
const ANTHROPIC_MODEL = 'claude-opus-5';

// ---- Pure functions (no I/O) - covered by test/supervisor-core.test.js ----

// Cheap baseline the scheduled run compares against next time, so most
// 15-minute ticks can skip the Anthropic call entirely.
function buildSkipCheckSnapshot(state, errorLog) {
  const lastErrorTime = errorLog && errorLog.length > 0 ? errorLog[0].time : null;
  return {
    tradesToday: state.tradesToday || 0,
    netProfit: (state.dailyProfit || 0) - (state.dailyLoss || 0),
    errorLogLen: errorLog ? errorLog.length : 0,
    lastErrorTime
  };
}

// No baseline yet (first ever run) just establishes one silently rather
// than always triggering a paid call on cold start. A pending item that
// just expired is always notable, even with nothing else changed.
function shouldReview(prevSnapshot, newSnapshot, pendingJustExpired) {
  if (pendingJustExpired) return true;
  if (!prevSnapshot) return false;
  if (newSnapshot.tradesToday !== prevSnapshot.tradesToday) return true;
  if (newSnapshot.errorLogLen !== prevSnapshot.errorLogLen) return true;
  if (newSnapshot.lastErrorTime !== prevSnapshot.lastErrorTime) return true;
  if (Math.abs(newSnapshot.netProfit - prevSnapshot.netProfit) > 0.005) return true;
  return false;
}

// Re-validates a proposed settings change through settings.js's existing
// validators - the same rule a dashboard/Telegram-command change is held
// to, never a separate copy of the logic.
function validateProposedChange(kind, value, currentSettings) {
  switch (kind) {
    case 'stakeAmount': {
      const v = settings.validateStakeAmount(value, currentSettings.dailyStopLoss);
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error };
    }
    case 'dailyProfitGoal':
    case 'weeklyProfitGoal': {
      const v = settings.validateProfitGoal(value);
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error };
    }
    case 'activeStrategy': {
      const v = settings.validateStrategy(value);
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.error };
    }
    case 'manualPause': {
      if (typeof value !== 'boolean') {
        return { ok: false, error: 'manualPause must be true or false' };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, error: `Unsupported proposal kind: ${kind}` };
  }
}

// Fails closed to {action: 'none'} on anything malformed or unexpected -
// a bad response from the model must never partially apply a change.
function parseSupervisorResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { action: 'none', parseError: 'Malformed JSON from model' };
  }

  const validActions = ['none', 'report', 'question', 'propose_change'];
  if (!parsed || !validActions.includes(parsed.action)) {
    return { action: 'none', parseError: 'Unrecognized or missing action from model' };
  }

  if ((parsed.action === 'report' || parsed.action === 'question') && typeof parsed.message !== 'string') {
    return { action: 'none', parseError: `Missing message for action "${parsed.action}"` };
  }

  if (parsed.action === 'propose_change') {
    const pc = parsed.proposed_change;
    if (!pc || !ALLOWED_PROPOSAL_KINDS.includes(pc.kind)) {
      return { action: 'none', parseError: 'Invalid or missing proposed_change.kind' };
    }
    return { action: 'propose_change', message: typeof parsed.message === 'string' ? parsed.message : '', proposed_change: pc };
  }

  return { action: parsed.action, message: parsed.message };
}

function buildSystemPrompt() {
  return [
    'You are a supervisor monitoring an automated Deriv trading bot (BandzzBot) on behalf of its owner.',
    'You never place trades and never write settings directly - you only observe, and when useful, communicate with the owner over Telegram.',
    'Each time you are invoked, choose exactly ONE of these actions:',
    '- "none": nothing worth saying right now. Prefer this unless there is something genuinely worth the owner\'s attention.',
    '- "report": send the owner a short factual observation (e.g. a notable win/loss streak, a stat worth knowing).',
    '- "question": ask the owner a short clarifying question when something is ambiguous and their answer would help.',
    `- "propose_change": propose changing exactly ONE setting, only when you have a specific, justified recommendation. Allowed kinds: ${ALLOWED_PROPOSAL_KINDS.join(', ')}. This never applies automatically - the owner must tap a button on Telegram.`,
    'Respond with ONLY a single JSON object, no markdown fences, no prose before or after it:',
    '{"action": "none|report|question|propose_change", "message": "...", "proposed_change": {"kind": "...", "value": ..., "reasoning": "..."}}',
    'Omit "proposed_change" unless action is "propose_change". Keep "message" short and plain - it is sent verbatim as a Telegram message, not a report.',
    'If the trigger reason (given in the JSON context below) starts with "user_ask", the owner directly asked you something and is waiting for a reply - always respond with action "report" containing a direct answer, never "none", even if the honest answer is just confirming current status.',
    'If the trigger reason starts with "user_reply", the owner just answered a question you asked earlier - act on it (a "report" acknowledging what you\'ll do, or a "propose_change" if their answer implies a specific settings change) or choose "none" if a plain acknowledgement isn\'t needed.'
  ].join('\n');
}

function buildUserContext(payload) {
  return JSON.stringify(payload, null, 2);
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenceMatch ? fenceMatch[1] : trimmed;
}

// ---- I/O ----

async function callAnthropicSupervisor(systemPrompt, userContent) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { skipped: true };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return { error: (data && data.error && data.error.message) || `HTTP ${response.status}` };
    }

    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return { error: 'No text content in Anthropic response' };
    }
    return { text: stripCodeFence(textBlock.text) };
  } catch (err) {
    return { error: err.message };
  }
}

// The core cycle: gather state, decide whether to bother the LLM, act on
// its decision. triggerReason is 'scheduled' | 'user_ask' | 'user_reply' -
// only 'scheduled' runs are subject to the cheap skip-check; a direct
// /ask or an answer to a pending question always calls through.
async function runSupervisorCycle(triggerReason, extraText) {
  const currentSettings = await memory.loadSettings();
  const strategyName = currentSettings.activeStrategy || 'accumulator';
  const state = await memory.loadState(strategyName);
  const weeklyState = await memory.loadWeeklyState(strategyName);
  const errorLog = await memory.getErrorLog(strategyName);
  const tradeHistory = await memory.getTradeHistory(strategyName);
  const stats = await memory.computeStats(strategyName);
  let supervisorState = await memory.loadSupervisorState();

  const newSnapshot = buildSkipCheckSnapshot(state, errorLog);
  const pendingJustExpired = memory.isPendingExpired(supervisorState.pendingQuestion) ||
    memory.isPendingExpired(supervisorState.pendingApproval);

  if (triggerReason === 'scheduled') {
    const needsReview = shouldReview(supervisorState.lastReviewedSnapshot, newSnapshot, pendingJustExpired);
    if (!needsReview) {
      supervisorState.lastRunAt = new Date().toISOString();
      await memory.saveSupervisorState(supervisorState);
      return { action: 'none', skipped: true, reason: 'nothing_notable' };
    }
  }

  // Resolve any expired pending item before considering a new one, so a
  // stale ask/proposal is never left silently unanswered forever.
  if (memory.isPendingExpired(supervisorState.pendingQuestion)) {
    await telegram.sendMessage('The question I asked earlier went unanswered too long, so I\'m dropping it.');
    await memory.clearPendingQuestion();
  }
  if (memory.isPendingExpired(supervisorState.pendingApproval)) {
    await telegram.sendMessage('The change I proposed earlier went unapproved too long, so I\'m discarding it.');
    await memory.clearPendingApproval();
  }
  supervisorState = await memory.loadSupervisorState();

  // Something is already live and this isn't the reply resolving it -
  // a scheduled tick should not pile a second ask/proposal on top.
  if ((supervisorState.pendingQuestion || supervisorState.pendingApproval) && triggerReason === 'scheduled') {
    supervisorState.lastRunAt = new Date().toISOString();
    await memory.saveSupervisorState(supervisorState);
    return { action: 'none', skipped: true, reason: 'pending_unresolved' };
  }

  const payload = {
    trigger: extraText ? `${triggerReason}: ${extraText}` : triggerReason,
    settings: currentSettings,
    today: {
      tradesToday: state.tradesToday,
      wins: state.wins,
      losses: state.losses,
      consecutiveLosses: state.consecutiveLosses,
      dailyProfit: state.dailyProfit,
      dailyLoss: state.dailyLoss,
      manualPause: state.manualPause,
      paused: state.paused
    },
    weekly: {
      weeklyProfit: weeklyState.weeklyProfit,
      weeklyLoss: weeklyState.weeklyLoss,
      weeklyProfitGoal: currentSettings.weeklyProfitGoal
    },
    recentTrades: tradeHistory.slice(-10),
    stats: {
      totalTrades: stats.totalTrades,
      totalWinRate: stats.totalWinRate,
      byHour: stats.byHour,
      bySymbol: stats.bySymbol
    },
    recentErrors: errorLog.slice(0, 5),
    conversationHistory: supervisorState.conversationHistory.slice(0, 10)
  };

  const llmResult = await callAnthropicSupervisor(buildSystemPrompt(), buildUserContext(payload));
  if (llmResult.skipped) {
    return { action: 'none', skipped: true, reason: 'not_configured' };
  }
  if (llmResult.error) {
    await memory.appendErrorLog(strategyName, `Supervisor LLM call failed: ${llmResult.error}`);
    return { action: 'none', error: llmResult.error };
  }

  const parsed = parseSupervisorResponse(llmResult.text);
  if (parsed.parseError) {
    await memory.appendErrorLog(strategyName, `Supervisor response parse failure: ${parsed.parseError} - raw: ${String(llmResult.text).slice(0, 500)}`);
  }

  supervisorState.lastReviewedSnapshot = newSnapshot;
  supervisorState.lastRunAt = new Date().toISOString();
  await memory.saveSupervisorState(supervisorState);

  if (parsed.action === 'none') {
    return parsed;
  }

  if (parsed.action === 'report') {
    await telegram.sendMessage(`\u{1F9ED} ${parsed.message}`);
    await memory.appendSupervisorConversation('assistant', parsed.message);
    return parsed;
  }

  if (parsed.action === 'question') {
    const pending = await memory.setPendingQuestion(parsed.message);
    if (!pending.ok) {
      return { action: 'none', reason: pending.error };
    }
    await telegram.sendMessage(`\u{2753} ${parsed.message}\n\n(Reply to this message to answer.)`);
    await memory.appendSupervisorConversation('assistant', parsed.message);
    return parsed;
  }

  if (parsed.action === 'propose_change') {
    const { kind, value, reasoning } = parsed.proposed_change;
    const validated = validateProposedChange(kind, value, currentSettings);
    if (!validated.ok) {
      await memory.appendErrorLog(strategyName, `Supervisor proposed an invalid change (${kind}=${value}): ${validated.error}`);
      return { action: 'none', reason: validated.error };
    }

    const humanSummary = `${kind} → ${validated.value}${reasoning ? ` (${reasoning})` : ''}`;
    const pending = await memory.setPendingApproval(kind, { [kind]: validated.value }, humanSummary);
    if (!pending.ok) {
      return { action: 'none', reason: pending.error };
    }

    await telegram.sendMessage(
      `\u{1F6E0} Proposal: <b>${kind}</b> → ${validated.value}\n${reasoning ? reasoning : ''}`,
      { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${pending.id}` },
        { text: '❌ Deny', callback_data: `deny:${pending.id}` }
      ]] }
    );
    await memory.appendSupervisorConversation('assistant', humanSummary);
    return parsed;
  }

  return parsed;
}

// Called from telegram-webhook.js when a free-text (non-command) message
// arrives and there's a live pending question to resolve it against.
async function answerPendingQuestion(answerText) {
  const supervisorState = await memory.loadSupervisorState();
  const pending = supervisorState.pendingQuestion;
  if (!pending || memory.isPendingExpired(pending)) {
    return { handled: false };
  }
  await memory.clearPendingQuestion();
  await memory.appendSupervisorConversation('user', answerText);
  await runSupervisorCycle('user_reply', answerText);
  return { handled: true };
}

// Called from telegram-webhook.js's "approve:<id>" callback. Re-validates
// against CURRENT settings (not the value captured when proposed) so a
// settings change made in between doesn't get blindly applied.
async function applyPendingApproval(id) {
  const supervisorState = await memory.loadSupervisorState();
  const pending = supervisorState.pendingApproval;
  if (!pending || pending.id !== id) {
    return { ok: false, alreadyResolved: true };
  }
  if (memory.isPendingExpired(pending)) {
    await memory.clearPendingApproval();
    return { ok: false, alreadyResolved: true };
  }

  const currentSettings = await memory.loadSettings();
  const kind = pending.kind;
  const rawValue = pending.proposedUpdate[kind];
  const revalidated = validateProposedChange(kind, rawValue, currentSettings);
  if (!revalidated.ok) {
    await memory.clearPendingApproval();
    return { ok: false, stale: true, error: revalidated.error };
  }

  if (kind === 'manualPause') {
    const strategyName = currentSettings.activeStrategy || 'accumulator';
    await memory.setManualPause(strategyName, revalidated.value);
  } else {
    const saved = await memory.saveSettings({ [kind]: revalidated.value });
    await memory.appendLog(saved.activeStrategy, `${kind} changed to ${revalidated.value} via supervisor approval`, 'info');
  }

  await memory.clearPendingApproval();
  return { ok: true, kind, value: revalidated.value };
}

// Called from telegram-webhook.js's "deny:<id>" callback.
async function denyPendingApproval(id) {
  const supervisorState = await memory.loadSupervisorState();
  const pending = supervisorState.pendingApproval;
  if (!pending || pending.id !== id) {
    return { ok: false, alreadyResolved: true };
  }
  await memory.clearPendingApproval();
  return { ok: true };
}

module.exports = {
  ALLOWED_PROPOSAL_KINDS,
  buildSkipCheckSnapshot,
  shouldReview,
  validateProposedChange,
  parseSupervisorResponse,
  buildSystemPrompt,
  buildUserContext,
  runSupervisorCycle,
  answerPendingQuestion,
  applyPendingApproval,
  denyPendingApproval
};
