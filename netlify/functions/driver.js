// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
//
// ONE bot, TWO strategies, ONE switch. settings.activeStrategy decides
// which logic runs each minute: 'rise_fall' (EMA/RSI on candles) or
// 'digit' (Digit Differ on tick frequency). Only one runs per invocation -
// they are not run in parallel. Switching strategies in the dashboard
// takes effect on the NEXT scheduled run.
//
// Each strategy keeps its own separate memory/risk state (keyed by
// strategy name), so switching back and forth doesn't mix up stats.
//
// IMPORTANT: Test with your DEMO token only. Do not point this at a
// real-money token yet.

const memory = require('./memory');
const risk = require('./risk');
const telegram = require('./telegram');
const riseFallStrategy = require('./strategy_rise_fall');
const digitStrategy = require('./strategy_digit');
const { getOtpWebSocketUrl } = require('./deriv-auth');

// ---- Config ----
const RISE_FALL_DURATION = 3; // ticks - shortened from 5 so contracts settle
                               // faster in real time, reducing pressure on
                               // the settle-wait timeout below
const RISE_FALL_DURATION_UNIT = 't';
const DIGIT_DURATION = 1; // ticks
const DIGIT_DURATION_UNIT = 't';
const EOD_HOUR_UTC = 23;
const TREND_CONFIRM_CANDLES = 8; // consecutive candles needed to confirm switch into trend regime
const RANGE_CONFIRM_CANDLES = 5; // consecutive candles needed to confirm switch back to range regime
// -----------------

exports.handler = async function () {
  const token = process.env.DERIV_TOKEN;
  const app_id = process.env.APP_ID || '1089';

  if (!token) {
    console.log('No DERIV_TOKEN set, exiting.');
    return { statusCode: 200, body: JSON.stringify({ message: 'No token configured' }) };
  }

  // Prevent overlapping runs. Netlify can retry a scheduled function
  // that runs too long (30s limit), and if the retry starts while the
  // original run is still mid-trade, both could try to place a trade
  // or write conflicting state. If a lock is already held (meaning a
  // very recent invocation is still active), skip this run entirely.
  const gotLock = await memory.acquireLock();
  if (!gotLock) {
    console.log('Skipped run - another invocation appears to still be in progress.');
    return { statusCode: 200, body: JSON.stringify({ message: 'Skipped - overlapping invocation detected' }) };
  }

  try {
    const settings = await memory.loadSettings();
    const strategyName = settings.activeStrategy || 'rise_fall';

    // Safety net: never let a single trade risk more than 20% of the
    // daily stop loss, regardless of what got saved.
    const maxSafeStake = settings.dailyStopLoss * 0.2;
    if (settings.stakeAmount > maxSafeStake) {
      console.log(`Stake $${settings.stakeAmount} exceeds safe max $${maxSafeStake}, clamping.`);
      await memory.appendLog(strategyName, `Stake clamped from $${settings.stakeAmount} to $${maxSafeStake.toFixed(2)} (safety limit)`, 'pause');
      settings.stakeAmount = maxSafeStake;
      await memory.saveSettings({ stakeAmount: maxSafeStake });
    }

    if (strategyName === 'digit') {
      return await runDigitStrategy(token, app_id, settings);
    } else {
      return await runRiseFallStrategy(token, app_id, settings);
    }
  } catch (err) {
    console.log('driver.js error:', err.message);
    return respond({ message: 'Error: ' + err.message });
  } finally {
    // Always release, even if something above threw or timed out,
    // otherwise every future run stays locked out forever.
    await memory.releaseLock();
  }
};

// ---- RISE/FALL branch ----
async function runRiseFallStrategy(token, app_id, settings) {
  const STRATEGY_NAME = 'rise_fall';
  const symbol = settings.symbol;

  const candleAuth = await getOtpWebSocketUrl(token, app_id);
  // Fetch enough candles to cover whatever periods are currently
  // configured, plus a buffer - a fixed count would silently break
  // the strategy if the user sets a longer EMA/RSI period than that.
  const neededCandles = Math.max(settings.emaSlowPeriod, settings.rsiPeriod + 1) + 20;
  const granularitySeconds = settings.candleGranularitySeconds || 15;
  const lookbackSeconds = neededCandles * granularitySeconds + 60; // small buffer

  // Build candles from raw ticks instead of Deriv's native candle
  // endpoint, which has a 1-minute floor. This lets the strategy react
  // to moves inside a single Deriv-native minute that it would
  // otherwise never see.
  const tickData = await connectAndGetTicksInRange(candleAuth.wsUrl, symbol, lookbackSeconds);
  const candles = buildCandlesFromTicks(tickData.prices, tickData.times, granularitySeconds);
  const closes = candles.map((c) => c.close);

  // Adaptive regime: compute ADX from real OHLC candles, then update
  // the persisted trend/range state (hysteresis-based, so it takes
  // several candles to actually switch regimes).
  let regime = 'range';
  let adx = null;
  if (settings.useAdaptiveRegime !== false) {
    adx = riseFallStrategy.calculateADX(candles, settings.adxPeriod || 14);
    const regimeResult = await memory.updateRegime(
      STRATEGY_NAME,
      adx,
      settings.adxTrendThreshold || 35,
      settings.adxRangeThreshold || 25,
      TREND_CONFIRM_CANDLES,
      RANGE_CONFIRM_CANDLES
    );
    regime = regimeResult.regime;
    if (regimeResult.switched) {
      await memory.appendLog(STRATEGY_NAME, `Regime switched to ${regime.toUpperCase()} (ADX ${adx !== null ? adx.toFixed(1) : '—'})`, 'pause');
    }
  }

  const signalResult = riseFallStrategy.getSignal(closes, {
    emaFastPeriod: settings.emaFastPeriod,
    emaSlowPeriod: settings.emaSlowPeriod,
    rsiPeriod: settings.rsiPeriod,
    rsiOverbought: settings.rsiOverbought,
    rsiOversold: settings.rsiOversold,
    requireRsiConfirmation: settings.requireRsiConfirmation,
    useAdaptiveRegime: settings.useAdaptiveRegime,
    regime,
    adx,
    adxFloorTrend: settings.adxFloorTrend,
    adxFloorRange: settings.adxFloorRange,
    biasEnabled: settings.biasEnabled,
    biasPeriod: settings.biasPeriod,
    biasThresholdPct: settings.biasThresholdPct
  });
  console.log('Signal check:', signalResult.reason);
  if (signalResult.signal) {
    await memory.appendLog(STRATEGY_NAME, `Signal: ${signalResult.signal} - ${signalResult.reason}`, 'info');
  }

  if (!signalResult.signal) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'No trade signal this run', ...signalResult });
  }

  const riskCheck = await handleRiskGate(STRATEGY_NAME);
  if (!riskCheck.canTrade) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
  }

  const stake = parseFloat(settings.stakeAmount || 1);
  await memory.setActiveTrade(STRATEGY_NAME, {
    direction: signalResult.signal,
    symbol,
    stake,
    placedAt: new Date().toISOString()
  });

  const tradeAuth = await getOtpWebSocketUrl(token, app_id);
  const tradeResult = await placeContractAndWait(tradeAuth.wsUrl, {
    contract_type: signalResult.signal,
    underlying_symbol: symbol,
    duration: RISE_FALL_DURATION,
    duration_unit: RISE_FALL_DURATION_UNIT,
    basis: 'stake',
    amount: stake,
    currency: 'USD'
  }, stake);

  if (tradeResult.error) {
    console.log('Trade execution error:', tradeResult.error);
    await memory.clearActiveTrade(STRATEGY_NAME);
    return respond({ message: 'Trade failed to execute', error: tradeResult.error });
  }

  const updatedState = await recordAndLogTrade(STRATEGY_NAME, signalResult.signal, symbol, stake, tradeResult, regime);
  await handlePostTradeRisk(STRATEGY_NAME, updatedState);
  await maybeSendEODReport(STRATEGY_NAME);

  return respond({
    message: `Trade placed: ${signalResult.signal} - ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
    signal: signalResult,
    trade: tradeResult,
    state: updatedState
  });
}

// ---- DIGIT branch ----
async function runDigitStrategy(token, app_id, settings) {
  const STRATEGY_NAME = 'digit';
  const symbol = settings.symbol;

  const tickAuth = await getOtpWebSocketUrl(token, app_id);
  const prices = await connectAndGetTicks(tickAuth.wsUrl, symbol, (settings.digitLookback || 20) + 5);

  const signalResult = digitStrategy.getSignal(prices, {
    lookback: settings.digitLookback || 20
  });
  console.log('Digit signal check:', signalResult.reason);
  if (signalResult.signal) {
    await memory.appendLog(STRATEGY_NAME, `Signal: DIFFER from ${signalResult.barrier} - ${signalResult.reason}`, 'info');
  }

  if (!signalResult.signal) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'No trade signal this run', ...signalResult });
  }

  const riskCheck = await handleRiskGate(STRATEGY_NAME);
  if (!riskCheck.canTrade) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
  }

  const stake = parseFloat(settings.stakeAmount || 1);
  await memory.setActiveTrade(STRATEGY_NAME, {
    direction: `DIFFER ${signalResult.barrier}`,
    symbol,
    stake,
    placedAt: new Date().toISOString()
  });

  const tradeAuth = await getOtpWebSocketUrl(token, app_id);
  const tradeResult = await placeContractAndWait(tradeAuth.wsUrl, {
    contract_type: 'DIGITDIFF',
    underlying_symbol: symbol,
    duration: DIGIT_DURATION,
    duration_unit: DIGIT_DURATION_UNIT,
    barrier: String(signalResult.barrier),
    basis: 'stake',
    amount: stake,
    currency: 'USD'
  }, stake);

  if (tradeResult.error) {
    console.log('Trade execution error:', tradeResult.error);
    await memory.clearActiveTrade(STRATEGY_NAME);
    return respond({ message: 'Trade failed to execute', error: tradeResult.error });
  }

  const updatedState = await recordAndLogTrade(STRATEGY_NAME, `DIFFER ${signalResult.barrier}`, symbol, stake, tradeResult);
  await handlePostTradeRisk(STRATEGY_NAME, updatedState);
  await maybeSendEODReport(STRATEGY_NAME);

  return respond({
    message: `Trade placed: DIFFER ${signalResult.barrier} - ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
    signal: signalResult,
    trade: tradeResult,
    state: updatedState
  });
}

// ---- Shared helpers ----

async function handleRiskGate(strategyName) {
  const riskCheck = await risk.checkCanTrade(strategyName);
  if (!riskCheck.canTrade) {
    console.log('Blocked by risk.js:', riskCheck.reason);

    if (riskCheck.reason.includes('cooldown started')) {
      await telegram.alertPaused(strategyName, riskCheck.reason);
    } else if (riskCheck.reason.includes('profit goal hit')) {
      const s = await memory.loadState(strategyName);
      if (!s.goalAlertSent) {
        await telegram.alertDailyGoalHit(strategyName, s.dailyProfit);
        s.goalAlertSent = true;
        await memory.saveState(strategyName, s);
      }
    } else if (riskCheck.reason.includes('stop loss hit')) {
      const s = await memory.loadState(strategyName);
      if (!s.stopLossAlertSent) {
        await telegram.alertStopLossHit(strategyName, s.dailyLoss);
        s.stopLossAlertSent = true;
        await memory.saveState(strategyName, s);
      }
    }
  }
  return riskCheck;
}

async function recordAndLogTrade(strategyName, direction, symbol, stake, tradeResult, regime) {
  const updatedState = await memory.recordTrade(strategyName, {
    won: tradeResult.won,
    profitOrLoss: tradeResult.profit,
    stake
  });
  await memory.setLastTrade(strategyName, {
    direction,
    symbol,
    stake,
    won: tradeResult.won,
    profit: tradeResult.profit,
    settledAt: new Date().toISOString()
  });
  await memory.clearActiveTrade(strategyName);
  await memory.appendLog(
    strategyName,
    `${direction} ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
    tradeResult.won ? 'win' : 'loss'
  );
  // Persistent history, separate from the rolling display log - this is
  // what enables real "when does this bot perform best" analysis later.
  await memory.recordTradeHistory(strategyName, {
    symbol,
    direction,
    stake,
    won: tradeResult.won,
    profit: tradeResult.profit,
    regime: regime || null
  });
  await telegram.alertTradeResult(strategyName, direction, symbol, stake, tradeResult.won, tradeResult.profit);
  return updatedState;
}

async function handlePostTradeRisk(strategyName, updatedState) {
  const postTradeRisk = await risk.checkCanTrade(strategyName);
  if (!postTradeRisk.canTrade) {
    if (postTradeRisk.reason.includes('profit goal hit') && !updatedState.goalAlertSent) {
      await telegram.alertDailyGoalHit(strategyName, updatedState.dailyProfit);
      updatedState.goalAlertSent = true;
      await memory.saveState(strategyName, updatedState);
    } else if (postTradeRisk.reason.includes('stop loss hit') && !updatedState.stopLossAlertSent) {
      await telegram.alertStopLossHit(strategyName, updatedState.dailyLoss);
      updatedState.stopLossAlertSent = true;
      await memory.saveState(strategyName, updatedState);
    } else if (postTradeRisk.reason.includes('cooldown started')) {
      await telegram.alertPaused(strategyName, postTradeRisk.reason);
    }
  }
}

function respond(body) {
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

async function maybeSendEODReport(strategyName) {
  const state = await memory.loadState(strategyName);
  const now = new Date();

  if (now.getUTCHours() >= EOD_HOUR_UTC && !state.eodSent) {
    state.eodSent = true;
    await memory.saveState(strategyName, state);
    await telegram.alertEODReport(strategyName, state);
  }
}

function connectAndGetTicksInRange(wsUrl, symbol, lookbackSeconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for tick history'));
      }
    }, 8000);

    ws.onopen = () => {
      const startEpoch = Math.floor(Date.now() / 1000) - lookbackSeconds;
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'ticks',
        start: startEpoch,
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
      if (res.msg_type === 'history') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        const history = res.history || (res.data && res.data.history) || {};
        resolve({
          prices: history.prices || [],
          times: history.times || []
        });
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

// Buckets raw ticks into fixed-size candles, the same way a real candle
// chart works, just at a resolution finer than Deriv's native 1-minute
// minimum. Ticks within the same time bucket become one candle.
function buildCandlesFromTicks(prices, times, granularitySeconds) {
  if (!prices.length) return [];

  const buckets = new Map(); // bucketStartEpoch -> array of prices in order

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i];
    const time = times[i];
    const bucketStart = Math.floor(time / granularitySeconds) * granularitySeconds;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(price);
  }

  const sortedBucketKeys = Array.from(buckets.keys()).sort((a, b) => a - b);

  return sortedBucketKeys.map((bucketStart) => {
    const bucketPrices = buckets.get(bucketStart);
    return {
      epoch: bucketStart,
      open: bucketPrices[0],
      high: Math.max(...bucketPrices),
      low: Math.min(...bucketPrices),
      close: bucketPrices[bucketPrices.length - 1]
    };
  });
}
// Used by the digit strategy - fetches the last N raw ticks by count.
function connectAndGetTicks(wsUrl, symbol, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for tick history'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'ticks',
        count: count,
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
      if (res.msg_type === 'history') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        const prices = (res.history && res.history.prices) || (res.data && res.data.history && res.data.history.prices) || [];
        resolve(prices);
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

// Generic contract placement - works for both rise/fall and digit
// contracts since the shape of 'parameters' differs but the buy/wait
// flow is identical.
function placeContractAndWait(wsUrl, parameters, stake) {
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
        parameters: parameters
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

          // Guard against Deriv occasionally returning a settled contract
          // without a usable profit field - better to flag it than let
          // a bad value corrupt the running P&L total silently.
          const rawProfit = contract.profit;
          const profit = Number.isFinite(rawProfit) ? rawProfit : (contract.sell_price - contract.buy_price);

          resolve({
            won: profit > 0,
            profit: Number.isFinite(profit) ? profit : 0,
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
