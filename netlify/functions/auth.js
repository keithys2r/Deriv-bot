// auth.js
// Shared gate for control.js and settings.js, which otherwise have zero
// authentication - anyone who finds the deployed Netlify URL could stop
// the bot or rewrite its stake/risk settings. Requires a DASHBOARD_SECRET
// env var and a matching X-Dashboard-Secret header on every request.
// Fails closed if the env var isn't set - same philosophy as deriv-auth.js's
// ALLOW_LIVE_TRADING gate: an unconfigured secret means "not set up yet",
// not "open to anyone".

function checkDashboardSecret(event) {
  const configured = process.env.DASHBOARD_SECRET;
  if (!configured) {
    return { ok: false, statusCode: 500, error: 'DASHBOARD_SECRET is not configured on the server - set it in Netlify env vars to enable dashboard access.' };
  }

  const headers = event.headers || {};
  const provided = headers['x-dashboard-secret'] || headers['X-Dashboard-Secret'] || '';
  if (provided !== configured) {
    return { ok: false, statusCode: 401, error: 'Invalid or missing dashboard secret.' };
  }

  return { ok: true };
}

module.exports = { checkDashboardSecret };
