// deriv-auth.js
// Shared helper: turns a Deriv PAT (Bearer token) into a ready-to-use
// WebSocket URL via the new API's accounts -> OTP flow.
// Used by driver.js and balance.js so this logic lives in one place.

const API_BASE = 'https://api.derivws.com';

async function getOtpWebSocketUrl(token, app_id, preferDemo = true) {
  const accountsRes = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
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

  const accounts = accountsData.data || accountsData.accounts || [];
  if (!accounts.length) {
    throw new Error('No accounts returned from Deriv: ' + JSON.stringify(accountsData));
  }

  const targetAccount = preferDemo
    ? (accounts.find((a) => a.account_type === 'demo') || accounts[0])
    : (accounts.find((a) => a.account_type === 'real') || accounts[0]);

  const accountId = targetAccount.account_id;
  if (!accountId) {
    throw new Error('Could not determine account ID from: ' + JSON.stringify(targetAccount));
  }

  const otpRes = await fetch(`${API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
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
    throw new Error('OTP fetch failed: ' + JSON.stringify(otpData.errors || otpData));
  }

  const wsUrl = (otpData.data && otpData.data.url) || otpData.url;
  if (!wsUrl) {
    throw new Error('No WebSocket URL in OTP response: ' + JSON.stringify(otpData));
  }

  return { wsUrl, accountId, account: targetAccount };
}

module.exports = { getOtpWebSocketUrl };
