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

    // Recover from a previous run that died mid-trade before this run
    // does anything else - a killed function can leave a contract open
    // on Deriv with nothing tracking it locally otherwise.
    await reconcileOrphanedTrade(token, app_id, strategyName);

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

  let symbol, signalResult, regime, adx;

  if (settings.autoSelectSymbol) {
    const watchlist = (settings.watchlist && settings.watchlist.length === 3) ? settings.watchlist : ['R_100', 'R_75', 'R_50'];

    // Scan all watchlist symbols concurrently - sequential would risk
    // blowing Netlify's 30s execution ceiling with 3x the fetch time.
    const scanResults = await Promise.all(
      watchlist.map((sym) => getSymbolSignal(token, app_id, sym, settings).catch((err) => ({
        symbol: sym, signal: null, reason: `Scan error: ${err.message}`, adx: null, regime: null
      })))
    );

    const summary = scanResults.map((r) => `${r.symbol}: ${r.signal ? r.signal : 'no signal'}${r.adx !== null && r.adx !== undefined ? ` (ADX ${r.adx.toFixed(1)})` : ''}`).join(' | ');
    console.log('Watchlist scan:', summary);
    await memory.appendLog(STRATEGY_NAME, `Scan: ${summary}`, 'info');

    // Pick the strongest candidate among symbols that actually have a
    // signal - ranked by ADX (higher = more confident regime read).
    // Falls back to watchlist order if ADX isn't available (classic mode).
    const candidates = scanResults.filter((r) => r.signal);
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.adx || 0) - (a.adx || 0));
      const chosen = candidates[0];
      symbol = chosen.symbol;
      signalResult = { signal: chosen.signal, reason: chosen.reason, details: chosen.details };
      regime = chosen.regime;
      adx = chosen.adx;
      console.log(`Chosen: ${symbol} - ${chosen.reason}`);
      await memory.appendLog(STRATEGY_NAME, `Chosen: ${symbol} - ${chosen.reason}`, 'info');
    } else {
      await maybeSendEODReport(STRATEGY_NAME);
      return respond({ message: 'No trade signal this run (scanned watchlist)', scan: scanResults });
    }
  } else {
    symbol = settings.symbol;
    const result = await getSymbolSignal(token, app_id, symbol, settings);
    signalResult = { signal: result.signal, reason: result.reason, details: result.details };
    regime = result.regime;
    adx = result.adx;

    console.log('Signal check:', signalResult.reason);
    if (signalResult.signal) {
      await memory.appendLog(STRATEGY_NAME, `Signal: ${signalResult.signal} - ${signalResult.reason}`, 'info');
    }

    if (!signalResult.signal) {
      await maybeSendEODReport(STRATEGY_NAME);
      return respond({ message: 'No trade signal this run', ...signalResult });
    }
  }

  const riskCheck = await handleRiskGate(STRATEGY_NAME);
  if (!riskCheck.canTrade) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
  }

  const stake = await getScaledStake(STRATEGY_NAME, settings);
  await memory.setActiveTrade(STRATEGY_NAME, {
    direction: signalResult.signal,
    symbol,
    stake,
    regime,
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
  }, stake, (contractId) => {
    // Fires as soon as the buy confirms, BEFORE waiting for settlement -
    // persists the contract ID immediately so a crash mid-wait leaves
    // enough info to recover the real outcome on a later run, instead
    // of an untraceable orphaned trade.
    memory.setActiveTrade(STRATEGY_NAME, {
      direction: signalResult.signal,
      symbol,
      stake,
      regime,
      contractId,
      placedAt: new Date().toISOString()
    }).catch((e) => console.log('Failed to persist contract ID:', e.message));
  });

  if (tradeResult.error) {
    console.log('Trade execution error:', tradeResult.error);
    if (!tradeResult.contractPlaced) {
      // Buy itself failed - nothing was actually placed on Deriv, safe to clear.
      await memory.clearActiveTrade(STRATEGY_NAME);
    } else {
      // Buy succeeded but settlement wait timed out - the contract IS
      // real and open on Deriv. Do NOT clear the marker; the next run's
      // reconciliation step will look it up and record the real outcome.
      console.log('Contract was placed but settlement wait timed out - leaving active trade marker for reconciliation next run.');
    }
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

// Fetches candles, computes regime (per-symbol, since different symbols
// can be in different regimes at once), and returns a signal - the core
// per-symbol logic shared by both manual mode and the watchlist scanner.
async function getSymbolSignal(token, app_id, symbol, settings) {
  const candleAuth = await getOtpWebSocketUrl(token, app_id);
  const neededCandles = Math.max(settings.emaSlowPeriod, settings.rsiPeriod + 1) + 20;
  const granularitySeconds = settings.candleGranularitySeconds || 15;
  const tickCount = Math.min(Math.max(neededCandles * 15, 1000), 5000);

  const tickData = await connectAndGetTicksForCandles(candleAuth.wsUrl, symbol, tickCount);
  let candles = buildCandlesFromTicks(tickData.prices, tickData.times, granularitySeconds);

  if (candles.length < neededCandles) {
    console.log(`[${symbol}] Tick-based candles insufficient (${candles.length}/${neededCandles}) - falling back to native candles.`);
    const fallbackAuth = await getOtpWebSocketUrl(token, app_id);
    candles = await connectAndGetNativeCandles(fallbackAuth.wsUrl, symbol, neededCandles);
  }

  const closes = candles.map((c) => c.close);

  let regime = 'range';
  let adx = null;
  if (settings.useAdaptiveRegime !== false) {
    adx = riseFallStrategy.calculateADX(candles, settings.adxPeriod || 14);
    const regimeResult = await memory.updateRegimeForSymbol(
      symbol,
      adx,
      settings.adxTrendThreshold || 35,
      settings.adxRangeThreshold || 25,
      TREND_CONFIRM_CANDLES,
      RANGE_CONFIRM_CANDLES
    );
    regime = regimeResult.regime;
    if (regimeResult.switched) {
      await memory.appendLog('rise_fall', `[${symbol}] Regime switched to ${regime.toUpperCase()} (ADX ${adx !== null ? adx.toFixed(1) : '—'})`, 'pause');
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

  return { symbol, signal: signalResult.signal, reason: signalResult.reason, details: signalResult.details, regime, adx };
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

  const stake = await getScaledStake(STRATEGY_NAME, settings);
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
  }, stake, (contractId) => {
    memory.setActiveTrade(STRATEGY_NAME, {
      direction: `DIFFER ${signalResult.barrier}`,
      symbol,
      stake,
      contractId,
      placedAt: new Date().toISOString()
    }).catch((e) => console.log('Failed to persist contract ID:', e.message));
  });

  if (tradeResult.error) {
    console.log('Trade execution error:', tradeResult.error);
    if (!tradeResult.contractPlaced) {
      await memory.clearActiveTrade(STRATEGY_NAME);
    } else {
      console.log('Contract was placed but settlement wait timed out - leaving active trade marker for reconciliation next run.');
    }
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

// Applies the weekly de-risk scaling to the base stake - as weekly net
// profit approaches the weekly goal, stake scales DOWN to protect gains
// already made. Never scales up, only ever protects.
async function getScaledStake(strategyName, settings) {
  const baseStake = parseFloat(settings.stakeAmount || 1);
  const weeklyProfitGoal = settings.weeklyProfitGoal;
  if (!weeklyProfitGoal || weeklyProfitGoal <= 0) return baseStake;

  const weeklyState = await memory.loadWeeklyState(strategyName);
  const weeklyNet = weeklyState.weeklyProfit - weeklyState.weeklyLoss;
  const scaleFactor = memory.getStakeScaleFactor(weeklyNet, weeklyProfitGoal);

  if (scaleFactor < 1.0) {
    const scaledStake = Math.max(0.35, baseStake * scaleFactor);
    console.log(`Weekly progress ${(weeklyNet / weeklyProfitGoal * 100).toFixed(0)}% toward goal - scaling stake from $${baseStake} to $${scaledStake.toFixed(2)}`);
    return scaledStake;
  }
  return baseStake;
}

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
  await memory.recordWeeklyTrade(strategyName, {
    won: tradeResult.won,
    profitOrLoss: tradeResult.profit
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

// Checks a specific contract's current status on Deriv - used to
// recover the real outcome of a trade that was placed by a previous
// run that died before recording the result. Resolves once, doesn't
// wait indefinitely for settlement like placeContractAndWait does.
function queryContractStatus(wsUrl, contractId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout querying contract status'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: contractId
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

      if (res.msg_type === 'proposal_open_contract') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        const contract = res.proposal_open_contract;
        if (!contract || Object.keys(contract).length === 0) {
          reject(new Error('Contract not found on Deriv'));
          return;
        }
        const rawProfit = contract.profit;
        const profit = Number.isFinite(rawProfit) ? rawProfit : 0;
        resolve({ isSold: !!contract.is_sold, profit });
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

// Recovers from a previous run dying mid-trade. Checks for a leftover
// active trade marker; if one exists with a contract ID and has had
// enough time to settle, queries Deriv directly for what actually
// happened and records the REAL outcome instead of losing it silently.
async function reconcileOrphanedTrade(token, app_id, strategyName) {
  const active = await memory.getActiveTrade(strategyName);
  if (!active) return;

  const ageMs = Date.now() - new Date(active.placedAt).getTime();

  if (!active.contractId) {
    // Died before we even got a contract ID back - nothing to look up.
    // Give it a grace period in case a concurrent run is still mid-buy,
    // then give up and clear it so it doesn't block forever.
    if (ageMs > 5 * 60 * 1000) {
      console.log(`WARNING: Orphaned active trade with no contract ID (${strategyName}), age ${(ageMs / 1000).toFixed(0)}s - clearing, outcome unknown.`);
      await memory.appendLog(strategyName, `Orphaned trade cleared (no contract ID, outcome unknown)`, 'pause');
      await memory.clearActiveTrade(strategyName);
    }
    return;
  }

  if (ageMs < 30000) {
    // Still within a normal settlement window - could genuinely still
    // be in-flight from a run that's about to finish normally. Don't
    // touch it yet.
    return;
  }

  console.log(`Reconciling orphaned trade: contract ${active.contractId}, age ${(ageMs / 1000).toFixed(0)}s`);

  try {
    const auth = await getOtpWebSocketUrl(token, app_id);
    const result = await queryContractStatus(auth.wsUrl, active.contractId);

    if (result.isSold) {
      await recordAndLogTrade(strategyName, active.direction, active.symbol, active.stake, {
        won: result.profit > 0,
        profit: result.profit
      }, active.regime || null);
      console.log(`Recovered orphaned trade: ${result.profit > 0 ? 'WON' : 'LOST'} $${Math.abs(result.profit).toFixed(2)}`);
      await memory.appendLog(strategyName, `Recovered orphaned trade: ${result.profit > 0 ? 'WON' : 'LOST'} $${Math.abs(result.profit).toFixed(2)}`, result.profit > 0 ? 'win' : 'loss');
    } else {
      console.log('Orphaned trade still open on Deriv - leaving it, will check again next run.');
    }
  } catch (err) {
    console.log(`WARNING: Could not reconcile orphaned trade ${active.contractId}: ${err.message} - clearing marker, outcome unknown.`);
    await memory.appendLog(strategyName, `Could not verify orphaned trade (${err.message}) - cleared, outcome unknown`, 'pause');
    await memory.clearActiveTrade(strategyName);
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

// Fallback used when tick-based candle building can't supply enough
// history (see above) - fetches Deriv's own pre-aggregated candles.
// Minimum granularity is 60s (Deriv's own floor), so this loses the
// sub-1-minute precision of the custom tick-built candles, but it's not
// subject to the same ~1000-tick-per-request cap.
function connectAndGetNativeCandles(wsUrl, symbol, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for native candle history'));
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        ticks_history: symbol,
        style: 'candles',
        granularity: 60,
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
      if (res.msg_type === 'candles') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        const rawCandles = res.candles || (res.data && res.data.candles) || [];
        resolve(rawCandles.map((c) => ({
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          epoch: c.epoch
        })));
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

function connectAndGetTicksForCandles(wsUrl, symbol, count) {
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
// flow is identical. onBought(contractId) fires as soon as the buy
// confirms, BEFORE waiting for settlement, so the caller can persist
// the contract ID immediately - critical for recovering the real
// outcome later if this function dies before settlement completes.
function placeContractAndWait(wsUrl, parameters, stake, onBought) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;
    let contractPlaced = false; // true once Deriv confirms the buy - tells
                                 // the caller whether a real contract is
                                 // open even if we later fail/time out

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ error: 'Timeout waiting for trade to settle', contractPlaced });
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
        resolve({ error: res.error.message, contractPlaced });
        return;
      }

      if (res.msg_type === 'buy') {
        const contractId = res.buy.contract_id;
        contractPlaced = true;
        if (onBought) {
          try { onBought(contractId); } catch (e) { console.log('onBought callback error:', e.message); }
        }
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
        resolve({ error: 'WS Error: ' + err.message, contractPlaced });
      }
    };
  });
}
