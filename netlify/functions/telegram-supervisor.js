// telegram-supervisor.js
// Scheduled every 15 min (see netlify.toml). This is the LLM-driven
// "supervisor" layer on top of the deterministic Telegram control in
// telegram-webhook.js/telegram.js: it looks at the bot's own state
// (P&L, trade history, errors, settings) and decides on its own whether
// to report something notable, ask a clarifying question, or propose a
// settings change - every proposed change requires an explicit Telegram
// button tap before memory.js ever gets written (see supervisor-core.js's
// applyPendingApproval). It never places trades and never talks to Deriv.
//
// A cheap local skip-check runs every tick (see supervisor-core.js's
// shouldReview); the actual Anthropic API call only happens when
// something notable changed since the last review, so a quiet 15-minute
// window costs nothing. If ANTHROPIC_API_KEY isn't set, this no-ops
// cleanly on every tick, same as telegram.js does when its own env vars
// are unset.

const { runSupervisorCycle } = require('./supervisor-core');

exports.handler = async function () {
  try {
    const result = await runSupervisorCycle('scheduled');
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.log('telegram-supervisor.js error:', err.message);
    return { statusCode: 200, body: JSON.stringify({ error: err.message }) };
  }
};
