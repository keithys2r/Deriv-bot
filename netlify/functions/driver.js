// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
//
// ONE bot, FOUR strategies, ONE switch. settings.activeStrategy decides
// which logic runs each minute: 'rise_fall' (EMA/RSI on candles),
// 'accumulator' (ADX-gated entry into an Accumulator contract),
// 'even_odd' (fade-the-hot-parity heuristic on DIGITEVEN/DIGITODD), or
// 'hybrid' (reads ADX and picks one of the other three each run - see
// runHybridStrategy). Only one runs per invocation - they are not run in
// parallel. Switching strategies in the dashboard takes effect on the
// NEXT scheduled run.
//
// Each strategy keeps its own separate memory/risk state (keyed by
// strategy name), so switching back and forth doesn't mix up stats.
//
// Rise/Fall and Accumulator have different trade LIFECYCLES:
// Rise/Fall settles within a handful of ticks, so a single invocation can
// block on placeContractAndWait() until it's done. Accumulators have no
// fixed expiry - they can stay open for many minutes, far longer than a
// single ~30s scheduled invocation. So the accumulator path instead BUYS
// AND RETURNS immediately, then POLLS the open contract on each
// subsequent run (same pattern reconcileOrphanedTrade already uses for
// crash recovery: check status, and if not sold yet, leave it and check
// again next run) until it's sold (via its native take-profit) or the
// max-hold-time safety timer forces a sell.
//
// IMPORTANT: Test with your DEMO token only. Do not point this at a
// real-money token yet.

const memory = require('./memory');
const risk = require('./risk');
const telegram = require('./telegram');
const riseFallStrategy = require('./strategy_rise_fall');
const accumulatorStrategy = require('./strategy_accumulator');
const evenOddStrategy = require('./strategy_even_odd');
const { getOtpWebSocketUrl } = require('./deriv-auth');

// ---- Config ----
const RISE_FALL_DURATION = 3; // ticks - shortened from 5 so contracts settle
                               // faster in real time, reducing pressure on
                               // the settle-wait timeout below
const RISE_FALL_DURATION_UNIT = 't';
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

  // Resolved inside the try block below, but declared here so the catch
  // block can still record the failure against the right strategy even
  // if the error happened before settings finished loading.
  let strategyName = 'rise_fall';

  try {
    const settings = await memory.loadSettings();
    strategyName = settings.activeStrategy || 'rise_fall';

    // Recover from a previous run that died mid-trade before this run
    // does anything else - a killed function can leave a contract open
    // on Deriv with nothing tracking it locally otherwise. For
    // 'accumulator' this only handles the pre-buy "no contract ID yet"
    // crash window - once a contract ID exists, reconcileOrphanedTrade
    // deliberately leaves it for runAccumulatorStrategy's own poll loop
    // to resolve (see the strategyName check inside it).
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

    let result;
    if (strategyName === 'accumulator') {
      result = await runAccumulatorStrategy(token, app_id, settings);
    } else if (strategyName === 'even_odd') {
      result = await runEvenOddStrategy(token, app_id, settings);
    } else if (strategyName === 'hybrid') {
      result = await runHybridStrategy(token, app_id, settings);
    } else {
      result = await runRiseFallStrategy(token, app_id, settings);
    }

    // A clean run clears any failure streak - a single blip shouldn't
    // linger toward the kill switch threshold indefinitely.
    await memory.recordApiSuccess(strategyName);
    return result;
  } catch (err) {
    console.log('driver.js error:', err.message);
    await memory.appendErrorLog(strategyName, err.message);

    // Kill switch: too many consecutive failed runs means something is
    // structurally broken (bad token, Deriv outage, sustained
    // throttling) rather than one-off - auto-pause instead of silently
    // failing forever with nobody finding out except by reading logs.
    const state = await memory.recordApiFailure(strategyName);
    if (state.consecutiveApiFailures >= memory.API_FAILURE_KILL_SWITCH) {
      if (!state.manualPause) {
        state.manualPause = true;
        console.log(`Kill switch tripped: ${state.consecutiveApiFailures} consecutive failures - auto-pausing ${strategyName}.`);
      }
      if (!state.killSwitchAlertSent) {
        state.killSwitchAlertSent = true;
        await telegram.alertPaused(strategyName, `Auto-paused after ${state.consecutiveApiFailures} consecutive API failures - hit Start once things look healthy again.`);
      }
      await memory.saveState(strategyName, state);
    }

    return respond({ message: 'Error: ' + err.message });
  } finally {
    // Always release, even if something above threw or timed out,
    // otherwise every future run stays locked out forever.
    await memory.releaseLock();
  }
};

// ---- RISE/FALL branch ----
// strategyName defaults to 'rise_fall' but can be overridden (hybrid
// mode passes 'hybrid') so the SAME entry/buy/record logic writes to a
// different state/stats bucket without duplicating any of it.
async function runRiseFallStrategy(token, app_id, settings, strategyName) {
  const STRATEGY_NAME = strategyName || 'rise_fall';

  let symbol, signalResult, regime, adx;

  if (settings.autoSelectSymbol) {
    const watchlist = (settings.watchlist && settings.watchlist.length === 3) ? settings.watchlist : ['R_100', 'R_75', 'R_50'];

    // Fetch all 3 symbols' candles in one batched connection (see
    // fetchCandlesForWatchlist) instead of one auth+connection per
    // symbol, then compute each signal from the already-fetched candles.
    const neededCandles = Math.max(settings.emaSlowPeriod, settings.rsiPeriod + 1) + 20;
    const granularitySeconds = settings.candleGranularitySeconds || 15;
    const candlesBySymbol = await fetchCandlesForWatchlist(token, app_id, watchlist, neededCandles, granularitySeconds);

    const scanResults = await Promise.all(
      watchlist.map((sym) => computeRiseFallSignal(sym, candlesBySymbol[sym] || [], settings).catch((err) => ({
        symbol: sym, signal: null, reason: `Scan error: ${err.message}`, adx: null, regime: null
      })))
    );

    const summary = scanResults.map((r) => `${r.symbol}: ${r.signal ? r.signal : 'no signal'}${r.adx !== null && r.adx !== undefined ? ` (ADX ${r.adx.toFixed(1)})` : ''}${r.confidence !== undefined ? ` [conf ${r.confidence.toFixed(2)}]` : ''}`).join(' | ');
    console.log('Watchlist scan:', summary);
    await memory.appendLog(STRATEGY_NAME, `Scan: ${summary}`, 'info');

    // Pick the strongest candidate among symbols that actually have a
    // signal - ranked by `confidence` (0-1, comparable across regimes),
    // NOT raw ADX. Raw ADX would always favor a TREND-regime candidate
    // over a RANGE-regime one, since TREND is *defined* as high ADX and
    // RANGE as low ADX - that was a real bug (see strategy_rise_fall.js's
    // confidence calculation for how each regime's read is scaled onto
    // the same footing). Falls back to watchlist order if confidence
    // isn't available (classic mode, which has no adaptive regime at all).
    const candidates = scanResults.filter((r) => r.signal);
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
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

    // Caps correlated re-entry (see computeRiseFallSignal's tradedThisEpisode
    // check) - only marked once the buy is confirmed real, not on a mere attempt.
    memory.markTradedThisEpisode(symbol).catch((e) => console.log('Failed to mark traded-this-episode:', e.message));
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

  const updatedState = await recordAndLogTrade(STRATEGY_NAME, signalResult.signal, symbol, stake, tradeResult, regime, null, undefined, 'rise_fall');
  await handlePostTradeRisk(STRATEGY_NAME, updatedState);
  await maybeSendEODReport(STRATEGY_NAME);

  return respond({
    message: `Trade placed: ${signalResult.signal} - ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
    signal: signalResult,
    trade: tradeResult,
    state: updatedState
  });
}

// Fetches candles for a symbol, building custom tick-bucketed candles
// first and falling back to Deriv's native 60s candles if there isn't
// enough tick history yet - shared by both the rise_fall signal path
// and the accumulator entry-gate path so the fallback logic lives once.
async function fetchCandlesForSymbol(token, app_id, symbol, neededCandles, granularitySeconds) {
  const candleAuth = await getOtpWebSocketUrl(token, app_id);
  const tickCount = Math.min(Math.max(neededCandles * 15, 1000), 5000);

  const tickData = await connectAndGetTicksForCandles(candleAuth.wsUrl, symbol, tickCount);
  let candles = buildCandlesFromTicks(tickData.prices, tickData.times, granularitySeconds);

  if (candles.length < neededCandles) {
    console.log(`[${symbol}] Tick-based candles insufficient (${candles.length}/${neededCandles}) - falling back to native candles.`);
    const fallbackAuth = await getOtpWebSocketUrl(token, app_id);
    candles = await connectAndGetNativeCandles(fallbackAuth.wsUrl, symbol, neededCandles);
  }

  return candles;
}

// Batched version of fetchCandlesForSymbol for scanning a whole
// watchlist at once: authenticates ONCE and fetches tick history for
// every symbol over a single WebSocket connection, instead of each
// symbol paying its own getOtpWebSocketUrl round-trip (2 REST calls +
// a fresh one-time OTP token each). Only symbols that come up short on
// tick history fall back to an individual native-candle request - most
// scans need zero fallback calls at all.
async function fetchCandlesForWatchlist(token, app_id, symbols, neededCandles, granularitySeconds) {
  const auth = await getOtpWebSocketUrl(token, app_id);
  const tickCount = Math.min(Math.max(neededCandles * 15, 1000), 5000);

  let tickResults;
  try {
    tickResults = await connectAndGetTicksForSymbols(auth.wsUrl, symbols, tickCount);
  } catch (err) {
    // Whole-connection failure - fall through and let every symbol
    // retry individually below rather than losing the entire scan.
    console.log(`Batched tick fetch failed (${err.message}) - falling back to per-symbol native candles.`);
    tickResults = {};
  }

  const candlesBySymbol = {};
  for (const symbol of symbols) {
    const tickData = tickResults[symbol];
    let candles = tickData ? buildCandlesFromTicks(tickData.prices, tickData.times, granularitySeconds) : [];

    if (candles.length < neededCandles) {
      console.log(`[${symbol}] Tick-based candles insufficient (${candles.length}/${neededCandles}) - falling back to native candles.`);
      try {
        const fallbackAuth = await getOtpWebSocketUrl(token, app_id);
        candles = await connectAndGetNativeCandles(fallbackAuth.wsUrl, symbol, neededCandles);
      } catch (err) {
        console.log(`[${symbol}] Native candle fallback also failed: ${err.message}`);
        candles = [];
      }
    }

    candlesBySymbol[symbol] = candles;
  }

  return candlesBySymbol;
}

// Fetches candles for one symbol, then computes its signal - the manual-
// symbol path. The watchlist scanner instead fetches all symbols' candles
// in one batch (fetchCandlesForWatchlist) and calls computeRiseFallSignal
// directly per symbol, since the fetch is what's expensive to repeat.
async function getSymbolSignal(token, app_id, symbol, settings) {
  const neededCandles = Math.max(settings.emaSlowPeriod, settings.rsiPeriod + 1) + 20;
  const granularitySeconds = settings.candleGranularitySeconds || 15;
  const candles = await fetchCandlesForSymbol(token, app_id, symbol, neededCandles, granularitySeconds);
  return computeRiseFallSignal(symbol, candles, settings);
}

// Computes regime (per-symbol, since different symbols can be in
// different regimes at once) and a signal from already-fetched candles.
// No I/O of its own - pure computation plus the regime persistence in
// memory.js, split out from getSymbolSignal so the watchlist scanner can
// reuse it without re-fetching candles per symbol.
async function computeRiseFallSignal(symbol, candles, settings) {
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

    // Cap correlated re-entry: this same regime read already produced a
    // trade on this symbol, and the regime hasn't changed since - refuse
    // to bet the identical read again every ~60s run (this is what
    // turned one questionable trend call into dozens of correlated
    // trades clustered in the same hour). Waits for either a genuine
    // regime switch (see updateRegimeForSymbol) or a fresh episode.
    if (regimeResult.tradedThisEpisode) {
      return {
        symbol,
        signal: null,
        reason: `[${symbol}] Already traded this ${regime.toUpperCase()} episode - waiting for a fresh regime switch`,
        details: { regime, adx },
        regime,
        adx,
        confidence: undefined
      };
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

  return { symbol, signal: signalResult.signal, reason: signalResult.reason, details: signalResult.details, regime, adx, confidence: signalResult.details ? signalResult.details.confidence : undefined };
}

// ---- EVEN/ODD branch ----
// Same short-lived lifecycle as Rise/Fall (settles within a handful of
// ticks), so this can block a single invocation on placeContractAndWait()
// too, instead of the accumulator's buy-and-poll pattern.
async function runEvenOddStrategy(token, app_id, settings, strategyName) {
  const STRATEGY_NAME = strategyName || 'even_odd';
  const symbol = settings.symbol;
  const lookback = settings.evenOddLookback || 20;
  const durationTicks = settings.evenOddDurationTicks || 1;

  const tickAuth = await getOtpWebSocketUrl(token, app_id);
  const tickData = await connectAndGetTicksForCandles(tickAuth.wsUrl, symbol, lookback + 5);

  const signalResult = evenOddStrategy.getSignal(tickData.prices, { lookback });
  console.log('Even/odd signal check:', signalResult.reason);
  if (signalResult.signal) {
    await memory.appendLog(STRATEGY_NAME, `Signal: ${signalResult.signal === 'DIGITEVEN' ? 'EVEN' : 'ODD'} - ${signalResult.reason}`, 'info');
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
  const direction = signalResult.signal === 'DIGITEVEN' ? 'EVEN' : 'ODD';
  await memory.setActiveTrade(STRATEGY_NAME, {
    direction,
    symbol,
    stake,
    placedAt: new Date().toISOString()
  });

  const tradeAuth = await getOtpWebSocketUrl(token, app_id);
  const tradeResult = await placeContractAndWait(tradeAuth.wsUrl, {
    contract_type: signalResult.signal,
    underlying_symbol: symbol,
    duration: durationTicks,
    duration_unit: 't',
    basis: 'stake',
    amount: stake,
    currency: 'USD'
  }, stake, (contractId) => {
    memory.setActiveTrade(STRATEGY_NAME, {
      direction,
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

  const updatedState = await recordAndLogTrade(STRATEGY_NAME, direction, symbol, stake, tradeResult, null, null, undefined, 'even_odd');
  await handlePostTradeRisk(STRATEGY_NAME, updatedState);
  await maybeSendEODReport(STRATEGY_NAME);

  return respond({
    message: `Trade placed: ${direction} - ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
    signal: signalResult,
    trade: tradeResult,
    state: updatedState
  });
}

// ---- ACCUMULATOR branch ----
// Unlike Rise/Fall, an accumulator has no fixed expiry, so this branch
// splits into two paths each run: (1) one is already open -> poll it
// (see pollActiveAccumulator), or (2) nothing is open -> look for a calm
// enough symbol to enter one.
async function runAccumulatorStrategy(token, app_id, settings, strategyName) {
  const STRATEGY_NAME = strategyName || 'accumulator';

  const active = await memory.getActiveTrade(STRATEGY_NAME);
  if (active && active.contractId) {
    return await pollActiveAccumulator(token, app_id, settings, active, STRATEGY_NAME);
  }

  const adxMaxEntry = settings.accumulatorAdxMaxEntry ?? accumulatorStrategy.DEFAULT_ADX_MAX_ENTRY;
  const adxPeriod = settings.adxPeriod || 14;
  const neededCandles = adxPeriod * 2 + 21; // calculateADX needs period*2+1 candles
  const granularitySeconds = settings.candleGranularitySeconds || 15;

  let symbol, adx, decisionReason;

  if (settings.autoSelectSymbol) {
    const watchlist = (settings.watchlist && settings.watchlist.length === 3) ? settings.watchlist : ['R_100', 'R_75', 'R_50'];

    // Fetch all 3 symbols' candles in one batched connection (see
    // fetchCandlesForWatchlist) instead of one auth+connection per
    // symbol, then run the entry gate on each already-fetched result.
    const candlesBySymbol = await fetchCandlesForWatchlist(token, app_id, watchlist, neededCandles, granularitySeconds);

    const scanResults = watchlist.map((sym) => {
      try {
        return { symbol: sym, ...accumulatorStrategy.getEntryDecision(candlesBySymbol[sym] || [], { adxPeriod, adxMaxEntry }) };
      } catch (err) {
        return { symbol: sym, canEnter: false, reason: `Scan error: ${err.message}`, adx: null };
      }
    });

    const summary = scanResults.map((r) => `${r.symbol}: ${r.adx !== null && r.adx !== undefined ? `ADX ${r.adx.toFixed(1)}` : 'n/a'}${r.canEnter ? ' (OK)' : ''}`).join(' | ');
    console.log('Accumulator watchlist scan:', summary);
    await memory.appendLog(STRATEGY_NAME, `Scan: ${summary}`, 'info');

    // Pick the CALMEST candidate that clears the gate - lowest ADX wins,
    // the inverse of rise_fall's ranking (which wants the strongest
    // trend confidence, not the calmest market).
    const candidates = scanResults.filter((r) => r.canEnter);
    if (candidates.length === 0) {
      await maybeSendEODReport(STRATEGY_NAME);
      return respond({ message: 'No calm-enough symbol this run (scanned watchlist)', scan: scanResults });
    }
    candidates.sort((a, b) => a.adx - b.adx);
    const chosen = candidates[0];
    symbol = chosen.symbol;
    adx = chosen.adx;
    decisionReason = chosen.reason;
    console.log(`Chosen: ${symbol} - ${decisionReason}`);
    await memory.appendLog(STRATEGY_NAME, `Chosen: ${symbol} - ${decisionReason}`, 'info');
  } else {
    symbol = settings.symbol;
    const candles = await fetchCandlesForSymbol(token, app_id, symbol, neededCandles, granularitySeconds);
    const decision = accumulatorStrategy.getEntryDecision(candles, { adxPeriod, adxMaxEntry });
    adx = decision.adx;
    decisionReason = decision.reason;

    console.log('Entry check:', decisionReason);
    if (!decision.canEnter) {
      await maybeSendEODReport(STRATEGY_NAME);
      return respond({ message: 'No entry this run', reason: decisionReason, adx });
    }
    await memory.appendLog(STRATEGY_NAME, `Entry: ${decisionReason}`, 'info');
  }

  const riskCheck = await handleRiskGate(STRATEGY_NAME);
  if (!riskCheck.canTrade) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
  }

  const stake = await getScaledStake(STRATEGY_NAME, settings);
  const growthRate = settings.accumulatorGrowthRate || 0.01;
  const takeProfit = parseFloat((stake * (settings.accumulatorTakeProfitPct || 0.05)).toFixed(2));
  const direction = `ACCU ${(growthRate * 100).toFixed(0)}%`;

  // Persist a marker BEFORE sending the buy, same as rise_fall does -
  // if this invocation dies between sending the buy and getting the
  // ack back, reconcileOrphanedTrade's "no contract ID yet" grace-period
  // path (see below) is what notices and eventually clears it, instead
  // of an unrecoverable silent orphan on Deriv's side.
  await memory.setActiveTrade(STRATEGY_NAME, { direction, symbol, stake, growthRate, takeProfit, placedAt: new Date().toISOString() });

  const tradeAuth = await getOtpWebSocketUrl(token, app_id);
  const buyResult = await placeAccumulatorAndReturn(tradeAuth.wsUrl, {
    contract_type: 'ACCU',
    underlying_symbol: symbol,
    growth_rate: growthRate,
    limit_order: { take_profit: takeProfit },
    basis: 'stake',
    amount: stake,
    currency: 'USD'
  }, stake);

  if (buyResult.error) {
    console.log('Accumulator buy error:', buyResult.error);
    if (buyResult.definitelyNotPlaced) {
      // Deriv explicitly rejected the buy - nothing is open, safe to clear now.
      await memory.clearActiveTrade(STRATEGY_NAME);
    } else {
      // Timeout or WS error - genuinely unknown whether Deriv processed
      // the buy. Leave the marker; reconcileOrphanedTrade's grace period
      // will clear it if it turns out nothing was actually placed.
      console.log('Buy outcome unknown (no explicit rejection) - leaving marker for reconciliation.');
    }
    return respond({ message: 'Trade failed to execute', error: buyResult.error });
  }

  await memory.setActiveTrade(STRATEGY_NAME, {
    direction,
    symbol,
    stake,
    growthRate,
    takeProfit,
    contractId: buyResult.contractId,
    placedAt: new Date().toISOString()
  });
  await memory.appendLog(STRATEGY_NAME, `Opened ${direction} on ${symbol} - target take-profit $${takeProfit.toFixed(2)}`, 'info');

  return respond({
    message: `Accumulator opened: ${direction} on ${symbol}, target take-profit $${takeProfit.toFixed(2)}`,
    symbol,
    adx,
    contractId: buyResult.contractId
  });
}

// Checks an open accumulator each run: if Deriv's native take-profit (or
// a knockout) has already sold it, record the outcome. Otherwise, if
// it's been open longer than the configured safety window, force a sell
// rather than let it run indefinitely. Otherwise, leave it - this IS the
// poll loop, there's no separate blocking "wait" step like Rise/Fall has.
async function pollActiveAccumulator(token, app_id, settings, active, strategyName) {
  const STRATEGY_NAME = strategyName || 'accumulator';
  const ageMs = Date.now() - new Date(active.placedAt).getTime();
  const maxHoldMs = (settings.accumulatorMaxHoldMinutes || 10) * 60 * 1000;

  let status;
  try {
    const statusAuth = await getOtpWebSocketUrl(token, app_id);
    status = await queryContractStatus(statusAuth.wsUrl, active.contractId);
  } catch (err) {
    // Mirrors reconcileOrphanedTrade's give-up behavior: a transient
    // failure should just retry next run, but a permanent one (e.g. a
    // bad contract ID) shouldn't leave the strategy stuck forever unable
    // to open a new trade. Grace period is longer than the max-hold
    // safety timer itself so a merely-slow API isn't mistaken for stuck.
    if (ageMs > maxHoldMs + 10 * 60 * 1000) {
      console.log(`WARNING: Could not check accumulator status for ${(ageMs / 60000).toFixed(1)}m (${err.message}) - clearing marker, outcome unknown.`);
      await memory.appendLog(STRATEGY_NAME, `Could not verify accumulator status (${err.message}) - cleared, outcome unknown`, 'pause');
      await memory.clearActiveTrade(STRATEGY_NAME);
      return respond({ message: 'Accumulator status permanently unrecoverable, marker cleared', error: err.message });
    }
    console.log(`Could not check accumulator status: ${err.message} - will retry next run.`);
    return respond({ message: 'Could not check accumulator status this run', error: err.message });
  }

  if (status.isSold) {
    // A knockout on an accumulator loses the full stake, so profit <= 0
    // reliably distinguishes it from a take-profit sale (profit > 0).
    const exitReason = status.profit > 0 ? 'take_profit' : 'knockout';
    const tradeResult = { won: status.profit > 0, profit: status.profit };
    const updatedState = await recordAndLogTrade(STRATEGY_NAME, active.direction, active.symbol, active.stake, tradeResult, null, exitReason, Math.round(ageMs / 1000), 'accumulator');
    await handlePostTradeRisk(STRATEGY_NAME, updatedState);
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({
      message: `Accumulator closed (${exitReason}): ${tradeResult.won ? 'WON' : 'LOST'} $${Math.abs(tradeResult.profit).toFixed(2)}`,
      trade: tradeResult,
      state: updatedState
    });
  }

  if (ageMs > maxHoldMs) {
    console.log(`Accumulator on ${active.symbol} exceeded max hold time (${(ageMs / 60000).toFixed(1)}m) - forcing sell.`);
    const sellResult = await forceSellAndWait(token, app_id, active.contractId);
    if (sellResult.error) {
      console.log('Force-sell failed:', sellResult.error, '- will retry next run.');
      return respond({ message: 'Force-sell attempt failed, will retry next run', error: sellResult.error });
    }
    const updatedState = await recordAndLogTrade(STRATEGY_NAME, active.direction, active.symbol, active.stake, sellResult, null, 'timeout', Math.round(ageMs / 1000), 'accumulator');
    await handlePostTradeRisk(STRATEGY_NAME, updatedState);
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({
      message: `Accumulator force-sold after max hold time: ${sellResult.won ? 'WON' : 'LOST'} $${Math.abs(sellResult.profit).toFixed(2)}`,
      trade: sellResult,
      state: updatedState
    });
  }

  return respond({ message: `Accumulator still open on ${active.symbol} (${(ageMs / 1000).toFixed(0)}s)`, ageSeconds: Math.round(ageMs / 1000) });
}

// ---- HYBRID branch ----
// Reads the market once (a single symbol's ADX, same math rise_fall
// already uses) and picks WHICH style fits current conditions, instead
// of the user committing to one style up front: calm ADX -> Accumulator
// (survival-focused), trending ADX -> Rise/Fall (trend-following),
// anything in between/no clear read -> Even/Odd (needs no directional
// read at all). Reuses the three run*Strategy functions completely
// unchanged - they're already generic by strategyName - just retargeted
// at the 'hybrid' state/stats bucket, so this gets its own P&L/risk
// limits/performance tab for free without duplicating any entry, buy,
// or record logic. No watchlist auto-scan - one symbol, like even_odd.
async function runHybridStrategy(token, app_id, settings) {
  const STRATEGY_NAME = 'hybrid';

  // An open accumulator-style trade has no fixed expiry and must be
  // polled to resolution first, same as the pure accumulator strategy -
  // can't abandon it just because this run's read points elsewhere now.
  // (Any OTHER kind of leftover active trade would already have been
  // resolved by reconcileOrphanedTrade before this function ever runs,
  // since rise_fall/even_odd trades settle within a single invocation
  // under normal operation - see its accumulator-shape check above.)
  const active = await memory.getActiveTrade(STRATEGY_NAME);
  if (active && active.contractId) {
    return await pollActiveAccumulator(token, app_id, settings, active, STRATEGY_NAME);
  }

  const symbol = settings.symbol;
  const adxPeriod = settings.adxPeriod || 14;
  const neededCandles = adxPeriod * 2 + 21; // calculateADX needs period*2+1 candles
  const granularitySeconds = settings.candleGranularitySeconds || 15;

  let adx;
  try {
    const candles = await fetchCandlesForSymbol(token, app_id, symbol, neededCandles, granularitySeconds);
    adx = riseFallStrategy.calculateADX(candles, adxPeriod);
  } catch (err) {
    return respond({ message: 'Hybrid market read failed this run', error: err.message });
  }

  const accumulatorCeiling = settings.accumulatorAdxMaxEntry ?? accumulatorStrategy.DEFAULT_ADX_MAX_ENTRY;
  const trendFloor = settings.adxTrendThreshold || 35;

  let picked, reason;
  if (adx !== null && adx <= accumulatorCeiling) {
    picked = 'accumulator';
    reason = `ADX ${adx.toFixed(1)} calm (<= ${accumulatorCeiling}) - survival mode`;
  } else if (adx !== null && adx >= trendFloor) {
    picked = 'rise_fall';
    reason = `ADX ${adx.toFixed(1)} trending (>= ${trendFloor}) - trend-following mode`;
  } else {
    picked = 'even_odd';
    reason = `ADX ${adx !== null ? adx.toFixed(1) : 'n/a'} choppy/unclear - no directional read needed`;
  }

  console.log(`Hybrid picked ${picked}: ${reason}`);
  await memory.appendLog(STRATEGY_NAME, `Picked ${picked.toUpperCase()} - ${reason}`, 'info');

  // Force manual-symbol mode on the sub-call regardless of the shared
  // autoSelectSymbol setting - hybrid already picked and analyzed this
  // one symbol for its ADX read, so the sub-strategy trading a DIFFERENT
  // symbol via its own watchlist scan would silently contradict that read.
  const subSettings = { ...settings, autoSelectSymbol: false, symbol };

  if (picked === 'accumulator') {
    return await runAccumulatorStrategy(token, app_id, subSettings, STRATEGY_NAME);
  } else if (picked === 'rise_fall') {
    return await runRiseFallStrategy(token, app_id, subSettings, STRATEGY_NAME);
  } else {
    return await runEvenOddStrategy(token, app_id, subSettings, STRATEGY_NAME);
  }
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

async function recordAndLogTrade(strategyName, direction, symbol, stake, tradeResult, regime, exitReason, holdSeconds, subStrategy) {
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
    regime: regime || null,
    exitReason: exitReason || null,
    holdSeconds: holdSeconds !== undefined ? holdSeconds : null,
    subStrategy: subStrategy || null
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

  // Accumulators poll their own open contract as a normal part of every
  // run (see pollActiveAccumulator), including exit-reason classification
  // (take-profit vs knockout vs timeout) this generic path doesn't know
  // how to do. Leave a contract-ID'd accumulator trade alone here
  // entirely, so the two paths can't race to record the same settled
  // trade - runAccumulatorStrategy always resolves it. Checked two ways:
  // strategyName itself is 'accumulator' for the pure strategy, but
  // hybrid mode can ALSO have an open accumulator-style trade under the
  // 'hybrid' bucket - active.growthRate is only ever set by an
  // accumulator buy, so its presence is a reliable shape check regardless
  // of which bucket the trade is filed under.
  if (strategyName === 'accumulator' || active.growthRate !== undefined) {
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

// Batched version of connectAndGetTicksForCandles - fetches tick history
// for MULTIPLE symbols over ONE WebSocket connection instead of one
// connection per symbol, by tagging each request with req_id (Deriv
// echoes it back verbatim) so responses can be matched to the symbol
// that asked for them. This is what actually cuts the per-scan Deriv
// connection/auth load (see fetchCandlesForWatchlist).
function connectAndGetTicksForSymbols(wsUrl, symbols, count) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;
    const results = {}; // symbol -> { prices, times } | null (per-symbol error)
    let remaining = symbols.length;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        reject(new Error('Timeout waiting for batched tick history'));
      }
    }, 8000);

    ws.onopen = () => {
      symbols.forEach((symbol) => {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          style: 'ticks',
          count: count,
          end: 'latest',
          req_id: symbol
        }));
      });
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);
      const symbol = res.req_id;
      if (!symbol || results[symbol] !== undefined) return; // already resolved or unrelated message

      if (res.error) {
        results[symbol] = null;
        remaining--;
      } else if (res.msg_type === 'history') {
        const history = res.history || (res.data && res.data.history) || {};
        results[symbol] = { prices: history.prices || [], times: history.times || [] };
        remaining--;
      }

      if (remaining <= 0 && !resolved) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(results);
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

// Generic contract placement - used by rise/fall, where the contract
// settles within a few ticks so it's safe to block the invocation on it.
// onBought(contractId) fires as soon as the buy confirms, BEFORE waiting
// for settlement, so the caller can persist the contract ID immediately -
// critical for recovering the real outcome later if this function dies
// before settlement completes.
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
          // without a usable profit field (seen in practice on fast 1-tick
          // digit contracts - is_sold can flip true in a message that
          // hasn't populated profit/sell_price yet). contract.status
          // ('won'/'lost') is the authoritative outcome when present, since
          // trusting profit > 0 alone means an unusable/zero profit reading
          // gets misread as a loss even on an actual win. And a fallback of
          // profit: 0 previously made a real loss silently vanish from P&L
          // (displays as a false "+$0.00", undercounts dailyLoss/stop-loss
          // tracking) - falling back to -stake on a confirmed loss instead
          // is the safe direction to be wrong in, since it can't hide a
          // loss the way defaulting to 0 did.
          const rawProfit = contract.profit;
          const computedProfit = Number.isFinite(rawProfit) ? rawProfit : (contract.sell_price - contract.buy_price);
          const won = contract.status ? contract.status === 'won' : computedProfit > 0;
          let profit = computedProfit;
          if (!Number.isFinite(profit)) {
            if (contract.status) {
              profit = won ? 0 : -stake;
              console.log(`WARNING: contract ${contract.contract_id} settled with no usable profit field - falling back to ${won ? 'won: $0 (unknown payout)' : `lost: -$${stake}`} based on status='${contract.status}'.`);
            } else {
              profit = 0;
              console.log(`WARNING: contract ${contract.contract_id} settled with no usable profit field AND no status - cannot determine real outcome, recording as $0. Check this trade manually.`);
            }
          }

          resolve({
            won,
            profit,
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

// Buys an accumulator and resolves as soon as the buy confirms - does
// NOT wait for settlement like placeContractAndWait does, because an
// accumulator can stay open far longer than a single invocation. The
// contract is checked on later runs instead, via queryContractStatus.
// On failure, `definitelyNotPlaced` is only true for an explicit Deriv
// rejection - a timeout or WS error leaves it false because whether the
// buy actually went through is genuinely unknown in that case.
function placeAccumulatorAndReturn(wsUrl, parameters, stake) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ error: 'Timeout waiting for buy confirmation', definitelyNotPlaced: false });
      }
    }, 15000);

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
        resolve({ error: res.error.message, definitelyNotPlaced: true });
        return;
      }

      if (res.msg_type === 'buy') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve({ contractId: res.buy.contract_id });
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve({ error: 'WS Error: ' + err.message, definitelyNotPlaced: false });
      }
    };
  });
}

// Sends a market sell (price: 0 = accept any price) for a still-open
// contract and waits for Deriv's acknowledgement. Used only for the
// accumulator max-hold-time safety timer - the actual settled profit is
// fetched afterward via queryContractStatus, not parsed out of this ack.
function sendSellRequest(wsUrl, contractId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        resolve({ error: 'Timeout waiting for sell confirmation' });
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({ sell: contractId, price: 0 }));
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

      if (res.msg_type === 'sell') {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve({ sold: true });
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

// Force-sells an accumulator that's exceeded the safety hold window, then
// queries its final settled profit in a separate connection - each OTP
// WebSocket URL is single-use, same reason every other WS action in this
// file re-authenticates before opening a new connection.
async function forceSellAndWait(token, app_id, contractId) {
  const sellAuth = await getOtpWebSocketUrl(token, app_id);
  const sellResult = await sendSellRequest(sellAuth.wsUrl, contractId);
  if (sellResult.error) return { error: sellResult.error };

  try {
    const statusAuth = await getOtpWebSocketUrl(token, app_id);
    const status = await queryContractStatus(statusAuth.wsUrl, contractId);
    return { won: status.profit > 0, profit: status.profit };
  } catch (err) {
    return { error: err.message };
  }
}
