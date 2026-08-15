// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
// Flow each run:
//   1. Connect + authorize to Deriv
//   2. Pull recent candle history
//   3. Ask strategy_rise_fall.js for a signal
//   4. If signal exists, ask risk.js if we're allowed to trade
//   5. If allowed, place the trade and wait for the result (short duration contract)
//   6. Record the outcome in memory.js
//   7. Send Telegram alerts for pause / goal / stop-loss / EOD report
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
// -----------------

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  // TEMPORARY DEBUG - remove after diagnosing the invalid token issue
  console.log('DEBUG token length:', token ? token.length : 'undefined');
  console.log('DEBUG token first 6 chars:', token ? token.slice(0, 6) : 'undefined');
  console.log('DEBUG token last 4 chars:', token ? token.slice(-4) : 'undefined');
  console.log('DEBUG app_id:', app_id);

  if (!token) {
    console.log('No DERIV_TOKEN set, exiting.');
    return { statusCode: 200, body: JSON.stringify({ message: 'No token configured' }) };
  }

  try {
    // Step 1 + 2: connect, authorize, pull candles
    const candles = await connectAndGetCandles(token, app_id);
    const closes = candles.map((c) => c.close);

    // Step 3: get signal
    const signalResult = strategy.getSignal(closes);
    console.log('Signal check:', signalResult.reason);

    if (!signalResult.signal) {
      await maybeSendEODReport();
      return respond({ message: 'No trade signal this run', ...signalResult });
    }

    // Step 4: risk check
    const riskCheck = await risk.checkCanTrade(STRATEGY_NAME);

    if (!riskCheck.canTrade) {
      console.log('Blocked by risk.js:', riskCheck.reason);

      // Only alert on pause/stop events, not every single blocked poll
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

    // Step 5: place the trade and wait for result
    const stake = parseFloat(process.env.STAKE_AMOUNT || '1');
    const tradeResult = await placeTradeAndWait(token, app_id, signalResult.signal, stake);

    if (tradeResult.error) {
      console.log('Trade execution error:', tradeResult.error);
      return respond({ message: 'Trade failed to execute', error: tradeResult.error });
    }

    // Step 6: record outcome
    const updatedState = await memory.recordTrade(STRATEGY_NAME, {
      won: tradeResult.won,
      profitOrLoss: tradeResult.profit,
      stake
    });

    // Step 7: post-trade goal/stop check + alert
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

// Sends the EOD report once per day, at/after EOD_HOUR_UTC.
// Uses a flag stored in memory state so it doesn't fire every run.
async function maybeSendEODReport() {
  const state = await memory.loadState(STRATEGY_NAME);
  const now = new Date();

  if (now.getUTCHours() >= EOD_HOUR_UTC && !state.eodSent) {
    state.eodSent = true;
    await memory.saveState(STRATEGY_NAME, state);
    await telegram.alertEODReport(STRATEGY_NAME, state);
  }
}

// Connects to Deriv, authorizes, and requests recent candle history.
// Returns an array of { open, high, low, close, epoch }.
function connectAndGetCandles(token, app_id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for candle history'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token }));
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

      if (res.msg_type === 'authorize') {
        ws.send(JSON.stringify({
          ticks_history: SYMBOL,
          style: 'candles',
          granularity: CANDLE_GRANULARITY,
          count: CANDLE_COUNT,
          end: 'latest'
        }));
      }

      if (res.msg_type === 'candles') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(res.candles || []);
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

// Places a CALL or PUT contract and waits for it to settle, since
// duration is short (ticks-based), this resolves within the function's
// execution window instead of needing a separate check-later step.
function placeTradeAndWait(token, app_id, direction, stake) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${app_id}`);
    let resolved = false;
    let contractId = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ error: 'Timeout waiting for trade to settle' });
      }
    }, 20000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ authorize: token }));
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

      if (res.msg_type === 'authorize') {
        ws.send(JSON.stringify({
          buy: 1,
          price: stake,
          parameters: {
            contract_type: direction, // 'CALL' or 'PUT'
            symbol: SYMBOL,
            duration: CONTRACT_DURATION,
            duration_unit: CONTRACT_DURATION_UNIT,
            basis: 'stake',
            amount: stake,
            currency: 'USD'
          }
        }));
      }

      if (res.msg_type === 'buy') {
        contractId = res.buy.contract_id;
        // Subscribe to contract updates so we know when it settles
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
