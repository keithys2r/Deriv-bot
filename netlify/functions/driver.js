// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
//
// Uses Deriv's NEW API via deriv-auth.js (accounts -> OTP -> WebSocket).
// Symbol, stake, and indicator settings now come from settings.js /
// memory.js instead of being hardcoded, so the frontend can control them.
//
// Flow each run:
//   1. Load user settings (symbol, stake, indicator periods)
//   2. Get candles via a new OTP connection
//   3. Ask strategy_rise_fall.js for a signal using those settings
//   4. If signal exists, ask risk.js if we're allowed to trade
//   5. If allowed, get a fresh OTP, place the trade, wait for it to settle
//   6. Record the outcome in memory.js (including activeTrade/lastTrade)
//   7. Send Telegram alerts for pause / goal / stop-loss / EOD report
//
// IMPORTANT: Test with your DEMO token only until you've watched this
// run for real over several days. Do not point this at a real-money
// token yet.

const memory = require('./memory');
const risk = require('./risk');
const telegram = require('./telegram');
const strategy = require('./strategy_rise_fall');
const { getOtpWebSocketUrl } = require('./deriv-auth');

const STRATEGY_NAME = strategy.STRATEGY_NAME; // 'rise_fall'

// ---- Config (fallback defaults if settings.js has nothing saved yet) ----
const CANDLE_GRANULARITY = 60; // 1-minute candles
const CANDLE_COUNT = 50; // how many candles of history to pull
const CONTRACT_DURATION = 5; // ticks
const CONTRACT_DURATION_UNIT = 't';
const EOD_HOUR_UTC = 23; // hour (0-23, UTC) to send end-of-day report
// -----------------

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    console.log('No DERIV_TOKEN set, exiting.');
    return { statusCode: 200, body: JSON.stringify({ message: 'No token configured' }) };
  }

  try {
    const settings = await memory.loadSettings();
    const symbol = settings.symbol;

    // Step 1: fresh OTP + candles
    const candleAuth = await getOtpWebSocketUrl(token, app_id);
    const candles = await connectAndGetCandles(candleAuth.wsUrl, symbol);
    const closes = candles.map((c) => c.close ?? c.Close ?? c[4]);

    // Step 2: get signal, using user-configured indicator settings
    const signalResult = strategy.getSignal(closes, {
      emaFastPeriod: settings.emaFastPeriod,
      emaSlowPeriod: settings.emaSlowPeriod,
      rsiPeriod: settings.rsiPeriod,
      rsiOverbought: settings.rsiOverbought,
      rsiOversold: settings.rsiOversold
    });
    console.log('Signal check:', signalResult.reason);
    await memory.appendLog(STRATEGY_NAME, signalResult.signal ? `Signal: ${signalResult.signal} - ${signalResult.reason}` : signalResult.reason, 'info');

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

    // Step 4: mark a trade as "active" before placing it, so the frontend
    // can show something is in flight even during the brief settle window
    const stake = parseFloat(settings.stakeAmount || 1);
    await memory.setActiveTrade(STRATEGY_NAME, {
      direction: signalResult.signal,
      symbol,
      stake,
      placedAt: new Date().toISOString()
    });

    // Step 5: fresh OTP for trade, place it, wait for result
    const tradeAuth = await getOtpWebSocketUrl(token, app_id);
    const tradeResult = await placeTradeAndWait(tradeAuth.wsUrl, symbol, signalResult.signal, stake);

    if (tradeResult.error) {
      console.log('Trade execution error:', tradeResult.error);
      await memory.clearActiveTrade(STRATEGY_NAME);
      return respond({ message: 'Trade failed to execute', error: tradeResult.error });
    }

    // Step 6: record outcome + clear active trade + set last trade
    const updatedState = await memory.recordTrade(STRATEGY_NAME, {
      won: tradeResult.won,
      profitOrLoss: tradeResult.profit,
      stake
    });
    await memory.setLastTrade(STRATEGY_NAME, {
      direction: signalResult.signal,
      symbol,
      stake,
      won: tradeResult.won,
      profit: tradeResult.profit,
      settledAt: new Date().toISOString()
    });
    await memory.clearActiveTrade(STRATEGY_NAME);
    await memory.appendLog(
      STRATEGY_NAME,
      `${signalResult.signal} ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
      tradeResult.won ? 'win' : 'loss'
    );

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
    await memory.clearActiveTrade(STRATEGY_NAME).catch(() => {});
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

// Connects using an OTP-embedded URL (already authenticated) and requests candles.
function connectAndGetCandles(wsUrl, symbol) {
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
        ticks_history: symbol,
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
function placeTradeAndWait(wsUrl, symbol, direction, stake) {
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
          underlying_symbol: symbol,
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
