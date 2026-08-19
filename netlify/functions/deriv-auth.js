// deriv-auth.js
// Shared helper: turns a Deriv PAT (Bearer token) into a ready-to-use
// WebSocket URL via the new API's accounts -> OTP flow.
// Used by driver.js and balance.js so this logic lives in one place.

const API_BASE = 'https://api.derivws.com';
const REST_TIMEOUT_MS = 4000; // each REST call gets its own hard timeout,
                               // since fetch() has no built-in one and a
                               // hang here could push total execution
                               // past Netlify's 30s scheduled function limit
const RETRY_DELAYS_MS = [400]; // retries a timeout/network failure once
                                // before giving up - a genuine Deriv
                                // rejection (non-2xx with a real body)
                                // is NOT retried, it fails immediately.
                                // Kept to a single retry (not two) because
                                // the empty-accounts loop below wraps this
                                // in its OWN retry loop - nesting two
                                // multi-attempt retries compounds fast
                                // (previously ~84s worst case for one
                                // getOtpWebSocketUrl call, well past the
                                // 30s budget a single call should ever use).
const EMPTY_ACCOUNTS_RETRY_DELAY_MS = 300;
const EMPTY_ACCOUNTS_MAX_ATTEMPTS = 2; // fixed, independent of RETRY_DELAYS_MS -
                                        // was tied to it before, which is what let
                                        // the two retry loops multiply together

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

// Retries fetchWithTimeout on a network/timeout failure (fetch() itself
// throwing - abort, DNS, connection reset) with a short delay between
// attempts. Does NOT retry a response that came back with a real HTTP
// status - that's Deriv actually answering, just with a rejection, and
// hammering it again won't change the answer.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fetchWithTimeout(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        console.log(`Deriv REST call failed (${err.message}), retrying in ${RETRY_DELAYS_MS[attempt]}ms...`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw lastErr;
}

async function getOtpWebSocketUrl(token, app_id, preferDemo = true) {
  // Hard gate, not just a default: even if a caller passes preferDemo:
  // false, it's overridden back to true unless ALLOW_LIVE_TRADING is
  // explicitly set. A real-money connection requires deliberately
  // setting an env var, not just a function argument somewhere changing.
  const effectivePreferDemo = isLiveTradingAllowed() ? preferDemo : true;

  // A 200 response with an empty accounts array has been observed as a
  // transient Deriv-side hiccup (not a genuine "you have no accounts"
  // answer) - fetchWithRetry above only retries on a network/timeout
  // failure, since a 200 is fetch() succeeding, so that gap needs its
  // own short retry here rather than failing the whole run on one flaky read.
  let accounts;
  let lastEmptyAccountsData;
  for (let attempt = 0; attempt < EMPTY_ACCOUNTS_MAX_ATTEMPTS; attempt++) {
    const accountsRes = await fetchWithRetry(`${API_BASE}/trading/v1/options/accounts`, {
      headers: {
        'Deriv-App-ID': app_id,
        'Authorization': `Bearer ${token}`
      }
    });

    const accountsRawText = await accountsRes.text();

    let accountsData;
    try {
      accountsData = JSON.parse(accountsRawText);
    } catch (e) {
      throw new Error(`Accounts endpoint returned non-JSON (status ${accountsRes.status}): ${accountsRawText.slice(0, 200)}`);
    }

    if (!accountsRes.ok) {
      throw new Error('Accounts fetch failed: ' + JSON.stringify(accountsData.errors || accountsData));
    }

    accounts = accountsData.data || accountsData.accounts || [];
    if (accounts.length) break;

    lastEmptyAccountsData = accountsData;
    if (attempt < EMPTY_ACCOUNTS_MAX_ATTEMPTS - 1) {
      console.log(`Deriv returned an empty accounts list (attempt ${attempt + 1}), retrying in ${EMPTY_ACCOUNTS_RETRY_DELAY_MS}ms...`);
      await sleep(EMPTY_ACCOUNTS_RETRY_DELAY_MS);
    }
  }

  if (!accounts.length) {
    throw new Error('No accounts returned from Deriv: ' + JSON.stringify(lastEmptyAccountsData));
  }

  // On the demo branch, do NOT fall back to accounts[0] - that could be a
  // real-money account, silently defeating the whole point of this gate.
  // The real branch is already a deliberate, gated opt-in (ALLOW_LIVE_TRADING),
  // so falling back there is an acceptable "just use whatever's available".
  let targetAccount;
  if (effectivePreferDemo) {
    targetAccount = accounts.find((a) => a.account_type === 'demo');
    if (!targetAccount) {
      throw new Error('No demo account found on this token, and live trading is not allowed (ALLOW_LIVE_TRADING is not set) - refusing to silently fall back to a non-demo account: ' + JSON.stringify(accounts));
    }
  } else {
    targetAccount = accounts.find((a) => a.account_type === 'real') || accounts[0];
  }

  const accountId = targetAccount.account_id;
  if (!accountId) {
    throw new Error('Could not determine account ID from: ' + JSON.stringify(targetAccount));
  }

  const otpRes = await fetchWithRetry(`${API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: {
      'Deriv-App-ID': app_id,
      'Authorization': `Bearer ${token}`
    }
  });

  const otpRawText = await otpRes.text();

  let otpData;
  try {
    otpData = JSON.parse(otpRawText);
  } catch (e) {
    throw new Error(`OTP endpoint returned non-JSON (status ${otpRes.status}): ${otpRawText.slice(0, 200)}`);
  }

  if (!otpRes.ok) {
    // Include which account was picked and the full accounts list Deriv
    // returned moments earlier - an OTP 404 right after the accounts
    // endpoint listed that same account_id means something about its
    // shape (id format, account_type, wallet linkage) doesn't match what
    // the OTP endpoint expects, and that's invisible without this context.
    throw new Error(
      `OTP fetch failed for account_id=${accountId} (account_type=${targetAccount.account_type}): ` +
      JSON.stringify(otpData.errors || otpData) +
      ' | accounts returned: ' + JSON.stringify(accounts)
    );
  }

  const wsUrl = (otpData.data && otpData.data.url) || otpData.url;
  if (!wsUrl) {
    throw new Error('No WebSocket URL in OTP response: ' + JSON.stringify(otpData));
  }

  return { wsUrl, accountId, account: targetAccount };
}

// Hard gate on real-money trading: demo is the default no matter what a
// caller passes as preferDemo, unless this env var is explicitly set to
// the string 'true'. Centralized here so every function that opens a
// Deriv connection enforces the same rule instead of relying on each
// call site remembering to pass the right flag.
function isLiveTradingAllowed() {
  return process.env.ALLOW_LIVE_TRADING === 'true';
}

module.exports = { getOtpWebSocketUrl, isLiveTradingAllowed };
