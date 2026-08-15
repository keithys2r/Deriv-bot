// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
//
// Rebuilt for Deriv's NEW API (developers.deriv.com), not the old
// ws.derivws.com/websockets/v3 "authorize" flow. New auth works like this:
//   1. GET /trading/v1/options/accounts  (Bearer token) -> list of accounts
//   2. POST /trading/v1/options/accounts/{accountId}/otp (Bearer token)
//      -> a one-time-use WebSocket URL (OTP valid 120 seconds, single use)
//   3. Connect directly to that URL - no further auth message needed
//
// Because the OTP is single-use, we request a FRESH one for the candle
// fetch, and another FRESH one for the trade placement.
//
// Flow each run:
//   1. Get candles via a new OTP connection
//   2. Ask strategy_rise_fall.js for a signal
//   3. If signal exists, ask risk.js if we're allowed to trade
//   4. If allowed, get a fresh OTP, place the trade, wait for it to settle
//   5. Record the outcome in memory.js
//   6. Send Telegram alerts for pause / goal / stop-loss / EOD report
//
// IMPORTANT: Test with your DEMO token only until you've watched this
// run for real over several days. Do not point this at a real-money
// token yet.

const memory = require('./memory');
const risk = require('./risk');
const telegram = require('./telegram');
const strategy = require('./strategy_rise_fall');

const STRATEGY_NAME = strategy.STRATEGY_NAME; // 'rise_fall'

// ---- Config ----
const SYMBOL = process.env.SYMBOL || 'R_100'; // Volatility 100 Index by default
const CANDLE_GRANULARITY = 60; // 1-minute candles
const CANDLE_COUNT = 50; // how many candles of history to pull
const CONTRACT_DURATION = 5; // ticks
const CONTRACT_DURATION_UNIT = 't';
const EOD_HOUR_UTC = 23; // hour (0-23, UTC) to send end-of-day report
const API_BASE = 'https://api.derivws.com';
// -----------------

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  console.log('DEBUG token length:', token ? token.length : 'undefined');
  console.log('DEBUG app_id:', app_id);

  if (!token) {
    console.log('No DERIV_TOKEN set, exiting.');
    return { statusCode: 200, body: JSON.stringify({ message: 'No token configured' }) };
  }

  try {
    // Step 1: fresh OTP + candles
    const candleWsUrl = await getOtpWebSocketUrl(token, app_id);
    const candles = await connectAndGetCandles(candleWsUrl);
    const closes = candles.map((c) => c.close ?? c.Close ?? c[4]);

    // Step 2: get signal
    const signalResult = strategy.getSignal(closes);
    console.log('Signal check:', signalResult.reason);

    if (!signalResult.signal) {
      await maybeSendEODReport();
      return respond({ message: 'No trade signal this run', ...signalResult });
    }

    // Step 3: risk check
    const riskCheck = await risk.checkCanTrade(STRATEGY_NAME);

    if (!riskCheck.canTrade) {
      console.log('Blocked by risk.js:', riskCheck.reason);

      if (riskCheck.reason.includes('cooldown started')) {
        await telegram.alertPaused(STRATEGY_NAME, riskCheck.reason);
      } else if (riskCheck.reason.includes('profit goal hit')) {
        await telegram.alertDailyGoalHit(STRATEGY_NAME, riskCheck.state.dailyProfit);
      } else if (riskCheck.reason.includes('stop loss hit')) {
        await telegram.alertStopLossHit(STRATEGY_NAME, riskCheck.state.dailyLoss);
      }

      await maybeSendEODReport();
      return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
    }

    // Step 4: fresh OTP for trade, place it, wait for result
    const stake = parseFloat(process.env.STAKE_AMOUNT || '1');
    const tradeWsUrl = await getOtpWebSocketUrl(token, app_id);
    const tradeResult = await placeTradeAndWait(tradeWsUrl, signalResult.signal, stake);

    if (tradeResult.error) {
      console.log('Trade execution error:', tradeResult.error);
      return respond({ message: 'Trade failed to execute', error: tradeResult.error });
    }

    // Step 5: record outcome
    const updatedState = await memory.recordTrade(STRATEGY_NAME, {
      won: tradeResult.won,
      profitOrLoss: tradeResult.profit,
      stake
    });

    // Step 6: post-trade goal/stop check + alert
    const postTradeRisk = await risk.checkCanTrade(STRATEGY_NAME);
    if (!postTradeRisk.canTrade) {
      if (postTradeRisk.reason.includes('profit goal hit')) {
        await telegram.alertDailyGoalHit(STRATEGY_NAME, updatedState.dailyProfit);
      } else if (postTradeRisk.reason.includes('stop loss hit')) {
        await telegram.alertStopLossHit(STRATEGY_NAME, updatedState.dailyLoss);
      } else if (postTradeRisk.reason.includes('cooldown started')) {
        await telegram.alertPaused(STRATEGY_NAME, postTradeRisk.reason);
      }
    }

    await maybeSendEODReport();

    return respond({
      message: `Trade placed: ${signalResult.signal} - ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
      signal: signalResult,
      trade: tradeResult,
      state: updatedState
    });
  } catch (err) {
    console.log('driver.js error:', err.message);
    return respond({ message: 'Error: ' + err.message });
  }
};

function respond(body) {
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

async function maybeSendEODReport() {
  const state = await memory.loadState(STRATEGY_NAME);
  const now = new Date();

  if (now.getUTCHours() >= EOD_HOUR_UTC && !state.eodSent) {
    state.eodSent = true;
    await memory.saveState(STRATEGY_NAME, state);
    await telegram.alertEODReport(STRATEGY_NAME, state);
  }
}

// ---- New API auth: accounts -> OTP -> WebSocket URL ----
async function getOtpWebSocketUrl(token, app_id) {
  const accountsRes = await fetch(`${API_BASE}/trading/v1/options/accounts`, {
    headers: {
      'Deriv-App-ID': app_id,
      'Authorization': `Bearer ${token}`
    }
  });

  const accountsRawText = await accountsRes.text();
  console.log('DEBUG accounts raw status:', accountsRes.status);
  console.log('DEBUG accounts raw text:', accountsRawText.slice(0, 500));

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

  // Try to find a demo/virtual account first
  const demoAccount = accounts.find((a) => a.account_type === 'demo') || accounts[0];

  const accountId = demoAccount.account_id;
  if (!accountId) {
    throw new Error('Could not determine account ID from: ' + JSON.stringify(demoAccount));
  }

  console.log('DEBUG using accountId:', accountId, 'raw account:', JSON.stringify(demoAccount).slice(0, 300));

  const otpRes = await fetch(`${API_BASE}/trading/v1/options/accounts/${accountId}/otp`, {
    method: 'POST',
    headers: {
      'Deriv-App-ID': app_id,
      'Authorization': `Bearer ${token}`
    }
  });

  const otpRawText = await otpRes.text();
  console.log('DEBUG otp raw status:', otpRes.status);
  console.log('DEBUG otp raw text:', otpRawText.slice(0, 300));

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

  return wsUrl;
}

// Connects using an OTP-embedded URL (already authenticated) and requests candles.
function connectAndGetCandles(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for candle history'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: SYMBOL,
        style: 'candles',
        granularity: CANDLE_GRANULARITY,
        count: CANDLE_COUNT,
        end: 'latest'
      }));
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);

      if (res.error) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        reject(new Error(res.error.message));
        return;
      }

      if (res.msg_type === 'candles') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(res.candles || (res.data && res.data.candles) || []);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(new Error('WS Error: ' + err.message));
      }
    };
  });
}

// Places a CALL or PUT contract using an OTP-embedded URL and waits for settlement.
// NOTE: 'symbol' is renamed to 'underlying_symbol' on the new API's buy/proposal calls.
function placeTradeAndWait(wsUrl, direction, stake) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ error: 'Timeout waiting for trade to settle' });
      }
    }, 20000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        buy: 1,
        price: stake,
        parameters: {
          contract_type: direction, // 'CALL' or 'PUT'
          underlying_symbol: SYMBOL,
          duration: CONTRACT_DURATION,
          duration_unit: CONTRACT_DURATION_UNIT,
          basis: 'stake',
          amount: stake,
          currency: 'USD'
        }
      }));
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);

      if (res.error) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve({ error: res.error.message });
        return;
      }

      if (res.msg_type === 'buy') {
        const contractId = res.buy.contract_id;
        ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1
        }));
      }

      if (res.msg_type === 'proposal_open_contract') {
        const contract = res.proposal_open_contract;
        if (contract.is_sold) {
          clearTimeout(timeout);
          resolved = true;
          ws.close();
          resolve({
            won: contract.profit > 0,
            profit: contract.profit,
            contractId: contract.contract_id,
            buyPrice: contract.buy_price,
            sellPrice: contract.sell_price
          });
        }
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve({ error: 'WS Error: ' + err.message });
      }
    };
  });
}
