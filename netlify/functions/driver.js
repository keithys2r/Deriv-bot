// driver.js
// Scheduled function - Netlify triggers this automatically on a timer.
//
// ONE bot, THREE strategies, ONE switch. settings.activeStrategy decides
// which logic runs each minute: 'accumulator' (ADX-gated entry into an
// Accumulator contract), 'digit_differ' (fixed-odds bets against one or
// more last digits - see runDigitDifferStrategy), or 'hybrid' (reads
// ADX and picks one of the other two each run - see runHybridStrategy).
// Only one runs per invocation - they are not run in parallel.
// Switching strategies in the dashboard takes effect on the NEXT
// scheduled run.
//
// A former 'rise_fall' strategy (EMA/RSI signal on candles) was removed
// entirely - direction-calling on these instruments can't sustainably
// beat ~50%, which didn't match the goal of styles that win consistently
// often. Recoverable from git history if ever wanted back.
//
// Each strategy keeps its own separate memory/risk state (keyed by
// strategy name), so switching back and forth doesn't mix up stats.
//
// Accumulator has a different trade LIFECYCLE than the other two:
// Accumulators have no fixed expiry - they can stay open for many
// minutes, far longer than a single ~30s scheduled invocation. So the
// accumulator path BUYS AND RETURNS immediately, then POLLS the open
// contract on each subsequent run (same pattern reconcileOrphanedTrade
// already uses for crash recovery: check status, and if not sold yet,
// leave it and check again next run) until it's sold (via its native
// take-profit) or the max-hold-time safety timer forces a sell.
// Digit Differ settles within a single tick, so a single invocation can
// block on placeDigitDifferBatchAndWait() until every bet in the batch
// is done, same philosophy the old Rise/Fall path used.
//
// IMPORTANT: Test with your DEMO token only. Do not point this at a
// real-money token yet.

const memory = require('./memory');
const risk = require('./risk');
const telegram = require('./telegram');
const { calculateADX } = require('./indicators');
const accumulatorStrategy = require('./strategy_accumulator');
const digitDifferStrategy = require('./strategy_digit_differ');
const { getOtpWebSocketUrl } = require('./deriv-auth');

// ---- Config ----
const EOD_HOUR_UTC = 23;
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
  let strategyName = 'accumulator';

  try {
    const settings = await memory.loadSettings();
    strategyName = settings.activeStrategy || 'accumulator';

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
    if (strategyName === 'hybrid') {
      result = await runHybridStrategy(token, app_id, settings);
    } else if (strategyName === 'digit_differ') {
      result = await runDigitDifferStrategy(token, app_id, settings);
    } else {
      result = await runAccumulatorStrategy(token, app_id, settings);
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

// Fetches candles for a symbol, building custom tick-bucketed candles
// first and falling back to Deriv's native 60s candles if there isn't
// enough tick history yet - shared by the accumulator entry-gate path
// and hybrid's own ADX read so the fallback logic lives once.
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

    // Pick the CALMEST candidate that clears the gate - lowest ADX wins.
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
  const targetTicks = settings.accumulatorTakeProfitTicks;
  const takeProfitPct = (targetTicks && targetTicks > 0)
    ? accumulatorStrategy.ticksToTakeProfitPct(growthRate, targetTicks)
    : (settings.accumulatorTakeProfitPct || 0.05);
  const takeProfit = parseFloat((stake * takeProfitPct).toFixed(2));
  const direction = `ACCU ${(growthRate * 100).toFixed(0)}%`;

  // Persist a marker BEFORE sending the buy so a mid-flight crash still
  // leaves a trace, then overwrite it with the real contractId once the
  // buy confirms below - pollActiveAccumulator (called via
  // runAccumulatorStrategy's own active-trade check) is what resolves
  // it from there on.
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

// ---- DIGIT DIFFER branch ----
// Fixed-odds, not directional - see strategy_digit_differ.js's header
// for why WHICH digits get excluded doesn't matter for the odds. Fires
// N simultaneous contracts (one per excluded digit) over one batched
// connection (placeDigitDifferBatchAndWait) and settles them all within
// this single invocation, same "block on it" philosophy the old
// Rise/Fall path used - Digit Differ is a 1-tick contract, so there's
// no accumulator-style long-hold lifecycle to poll for.
async function runDigitDifferStrategy(token, app_id, settings, strategyName) {
  const STRATEGY_NAME = strategyName || 'digit_differ';
  const symbol = settings.symbol;
  const excludeCount = settings.digitDifferExcludeCount || digitDifferStrategy.DEFAULT_EXCLUDE_COUNT;
  const digits = digitDifferStrategy.pickExcludedDigits(excludeCount, Math.floor(Date.now() / 60000));

  const riskCheck = await handleRiskGate(STRATEGY_NAME);
  if (!riskCheck.canTrade) {
    await maybeSendEODReport(STRATEGY_NAME);
    return respond({ message: 'Trade blocked by risk rules', reason: riskCheck.reason });
  }

  // settings.stakeAmount is the total risk for this trade EVENT, same
  // meaning it has for every other strategy here - split evenly across
  // the N simultaneous bets rather than each bet risking the full
  // configured amount (which would make total exposure scale with
  // however many digits are excluded, surprising given every other
  // strategy's stake setting means "total risk per trade").
  const totalStake = await getScaledStake(STRATEGY_NAME, settings);
  const perBetStake = Math.round((totalStake / digits.length) * 100) / 100;

  const bets = digits.map((digit) => ({ digit, stake: perBetStake, symbol, duration: 1, duration_unit: 't' }));

  // Persist a marker BEFORE sending any buys, same crash-recovery
  // philosophy as every other strategy here - reconcileOrphanedDigitDifferBatch
  // is what notices and resolves this if the invocation dies mid-batch.
  const placedAt = new Date().toISOString();
  await memory.setActiveTrade(STRATEGY_NAME, {
    digits,
    symbol,
    stake: perBetStake,
    contractIds: new Array(digits.length).fill(null),
    placedAt
  });

  const tradeAuth = await getOtpWebSocketUrl(token, app_id);
  const results = await placeDigitDifferBatchAndWait(tradeAuth.wsUrl, bets, (i, contractId) => {
    // Fires as soon as EACH buy confirms, before any of them settle -
    // persist contract IDs incrementally so a mid-batch crash leaves
    // enough info for reconciliation instead of an untraceable orphan.
    memory.getActiveTrade(STRATEGY_NAME).then((active) => {
      if (!active) return;
      active.contractIds[i] = contractId;
      return memory.setActiveTrade(STRATEGY_NAME, active);
    }).catch((e) => console.log('Failed to persist digit-differ contract ID:', e.message));
  });

  // placeDigitDifferBatchAndWait's own 20s timeout RESOLVES (never rejects)
  // for any bet that was bought but hasn't settled yet - those are real
  // open contracts on Deriv, not failures. Clearing the marker for those
  // would untrack them for good, so split settled results (recorded now,
  // as before) from still-pending ones (re-marked so
  // reconcileOrphanedDigitDifferBatch picks them up next run) before
  // deciding whether to clear the marker at all.
  let totalProfit = 0;
  const summaries = [];
  const pendingDigits = [];
  const pendingContractIds = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.error) {
      if (r.contractPlaced) {
        pendingDigits.push(digits[i]);
        pendingContractIds.push(r.contractId);
        summaries.push(`digit${digits[i]}: PENDING (${r.error})`);
      } else {
        console.log(`Digit ${digits[i]} bet failed: ${r.error}`);
        summaries.push(`digit${digits[i]}: ERROR (${r.error})`);
      }
      continue;
    }
    totalProfit += r.profit;
    const updatedState = await recordAndLogTrade(STRATEGY_NAME, `DIFF≠${digits[i]}`, symbol, perBetStake, r, null, null, undefined, 'digit_differ');
    summaries.push(`digit${digits[i]}: ${r.won ? 'WON' : 'LOST'} $${Math.abs(r.profit).toFixed(2)}`);
    await handlePostTradeRisk(STRATEGY_NAME, updatedState);
  }

  if (pendingContractIds.length > 0) {
    await memory.setActiveTrade(STRATEGY_NAME, {
      digits: pendingDigits,
      symbol,
      stake: perBetStake,
      contractIds: pendingContractIds,
      placedAt
    });
  } else {
    await memory.clearActiveTrade(STRATEGY_NAME);
  }

  await maybeSendEODReport(STRATEGY_NAME);

  return respond({
    message: `Digit Differ batch (avoiding ${digits.join(',')}): ${summaries.join(' | ')} - net $${totalProfit.toFixed(2)}`,
    totalProfit,
    results: summaries
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
    const { won, profit } = wonFromStatus(status, active.stake);
    const exitReason = won ? 'take_profit' : 'knockout';
    const tradeResult = { won, profit };
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
    const sellResult = await forceSellAndWait(token, app_id, active.contractId, active.stake);
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
// Reads ADX on the user's chosen symbol each run and picks WHICH style
// fits current conditions: calm ADX -> Accumulator (survival-focused,
// needs a genuinely calm market to have good odds), anything else ->
// Digit Differ (fixed-odds, doesn't care about market conditions at
// all, so it's the sensible fallback for every non-calm read). Reuses
// the two run*Strategy functions completely unchanged - they're already
// generic by strategyName - just retargeted at the 'hybrid' state/stats
// bucket, so this gets its own P&L/risk limits/performance tab for free
// without duplicating any entry, buy, or record logic. No watchlist
// auto-scan - one symbol only.
async function runHybridStrategy(token, app_id, settings) {
  const STRATEGY_NAME = 'hybrid';

  // An open accumulator-style trade has no fixed expiry and must be
  // polled to resolution first, same as the pure accumulator strategy -
  // can't abandon it just because this run's read points elsewhere now.
  // (A leftover digit_differ-shaped trade would already have been
  // resolved by reconcileOrphanedTrade before this function ever runs,
  // since digit_differ trades settle within a single invocation under
  // normal operation - see its own shape check there.)
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
    adx = calculateADX(candles, adxPeriod);
  } catch (err) {
    return respond({ message: 'Hybrid market read failed this run', error: err.message });
  }

  const accumulatorCeiling = settings.accumulatorAdxMaxEntry ?? accumulatorStrategy.DEFAULT_ADX_MAX_ENTRY;
  const { picked, reason } = pickHybridBucket(adx, accumulatorCeiling);

  console.log(`Hybrid picked ${picked}: ${reason}`);
  await memory.appendLog(STRATEGY_NAME, `Picked ${picked.toUpperCase()} - ${reason}`, 'info');

  // Force manual-symbol mode on the sub-call regardless of the shared
  // autoSelectSymbol setting - hybrid already picked and analyzed this
  // one symbol for its ADX read, so the sub-strategy trading a DIFFERENT
  // symbol via its own watchlist scan would silently contradict that read.
  const subSettings = { ...settings, autoSelectSymbol: false, symbol };

  if (picked === 'accumulator') {
    return await runAccumulatorStrategy(token, app_id, subSettings, STRATEGY_NAME);
  } else {
    return await runDigitDifferStrategy(token, app_id, subSettings, STRATEGY_NAME);
  }
}

// Pure decision: which sub-strategy style fits the current ADX read.
// Extracted so it's unit-testable without any I/O. Only a two-way split
// now that Rise/Fall (which needed a genuine "unclear zone" to defer
// to its own regime logic) is gone - Digit Differ doesn't care about
// market conditions at all, so it's simply the fallback whenever the
// market isn't calm enough for Accumulator.
function pickHybridBucket(adx, accumulatorCeiling) {
  if (adx !== null && adx !== undefined && adx <= accumulatorCeiling) {
    return { picked: 'accumulator', reason: `ADX ${adx.toFixed(1)} calm (<= ${accumulatorCeiling}) - survival mode` };
  }
  return {
    picked: 'digit_differ',
    reason: `ADX ${adx !== null && adx !== undefined ? adx.toFixed(1) : 'n/a'} not calm enough for accumulator (> ${accumulatorCeiling}) - fixed-odds mode`
  };
}

// ---- Shared helpers ----

// Applies three independent, purely-DOWNWARD-scaling factors to the base
// stake: weekly de-risking (protects gains as the weekly goal nears),
// losing-streak de-risking (backs off smoothly instead of trading full
// size right up until risk.js's cooldown cuts it to zero), and signal
// confidence (no current strategy produces a confidence score - kept as
// an optional no-op hook for a future one that does). All three are
// <= 1.0 and multiply together, so the scaled-down result can never
// exceed baseStake. The $0.35 floor below is clamped to the 20%-of-
// dailyStopLoss safety limit too, so a very low dailyStopLoss can't let
// the floor push a trade above that limit.
async function getScaledStake(strategyName, settings, confidence) {
  const baseStake = parseFloat(settings.stakeAmount || 1);

  const weeklyProfitGoal = settings.weeklyProfitGoal;
  let weeklyFactor = 1.0;
  let weeklyNet = 0;
  if (weeklyProfitGoal && weeklyProfitGoal > 0) {
    const weeklyState = await memory.loadWeeklyState(strategyName);
    weeklyNet = weeklyState.weeklyProfit - weeklyState.weeklyLoss;
    weeklyFactor = memory.getStakeScaleFactor(weeklyNet, weeklyProfitGoal);
  }

  const state = await memory.loadState(strategyName);
  const losingStreakFactor = memory.getLosingStreakScaleFactor(state.consecutiveLosses, settings.maxConsecutiveLosses);

  const confidenceFactor = memory.getConfidenceScaleFactor(confidence);

  const combinedFactor = weeklyFactor * losingStreakFactor * confidenceFactor;

  if (combinedFactor < 1.0) {
    // Deriv rejects a price with more than 2 decimal places - the three
    // factors above multiply to an essentially-never-clean float (unlike
    // the old single weekly-only factor, which was always a round
    // fraction), so this MUST be rounded before being sent as a trade
    // price, not just for display. Round after the $0.35 floor so the
    // floor itself can't get nudged back under by rounding.
    const maxSafeStake = settings.dailyStopLoss > 0 ? settings.dailyStopLoss * 0.2 : baseStake;
    const floor = Math.min(0.35, maxSafeStake);
    if (floor < 0.35) {
      console.log(`Stake floor reduced from $0.35 to $${floor.toFixed(2)} to respect the 20%-of-dailyStopLoss safety clamp (dailyStopLoss=$${settings.dailyStopLoss}).`);
    }
    const scaledStake = Math.round(Math.max(floor, baseStake * combinedFactor) * 100) / 100;
    console.log(`Stake scaled: weekly=${weeklyFactor.toFixed(2)} (${weeklyProfitGoal ? (weeklyNet / weeklyProfitGoal * 100).toFixed(0) + '%' : 'n/a'}) losingStreak=${losingStreakFactor.toFixed(2)} (${state.consecutiveLosses || 0} losses) confidence=${confidenceFactor.toFixed(2)} -> $${baseStake} to $${scaledStake.toFixed(2)}`);
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
    } else if (riskCheck.reason.startsWith('Weekly profit goal hit')) {
      const w = await memory.loadWeeklyState(strategyName);
      if (!w.weeklyGoalAlertSent) {
        const s = await memory.loadState(strategyName);
        await telegram.alertWeeklyGoalHit(strategyName, w.weeklyProfit - w.weeklyLoss, s.dailyProfit - s.dailyLoss);
        w.weeklyGoalAlertSent = true;
        await memory.saveWeeklyState(strategyName, w);
      }
    } else if (riskCheck.reason.includes('profit goal hit')) {
      const s = await memory.loadState(strategyName);
      if (!s.goalAlertSent) {
        await telegram.alertDailyGoalHit(strategyName, s.dailyProfit - s.dailyLoss);
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
    if (postTradeRisk.reason.startsWith('Weekly profit goal hit')) {
      const w = await memory.loadWeeklyState(strategyName);
      if (!w.weeklyGoalAlertSent) {
        await telegram.alertWeeklyGoalHit(strategyName, w.weeklyProfit - w.weeklyLoss, updatedState.dailyProfit - updatedState.dailyLoss);
        w.weeklyGoalAlertSent = true;
        await memory.saveWeeklyState(strategyName, w);
      }
    } else if (postTradeRisk.reason.includes('profit goal hit') && !updatedState.goalAlertSent) {
      await telegram.alertDailyGoalHit(strategyName, updatedState.dailyProfit - updatedState.dailyLoss);
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
        const computedProfit = Number.isFinite(rawProfit) ? rawProfit : (contract.sell_price - contract.buy_price);
        if (contract.is_sold && !Number.isFinite(computedProfit)) {
          // Deriv marked it sold but neither profit nor sell_price/buy_price
          // is usable yet - a real win was once silently recorded as a $0
          // loss here because of this exact gap. Don't guess: report as
          // still-open so the next scheduled poll (60s later) tries again
          // with data Deriv has had time to finalize, instead of ever
          // writing a fabricated outcome into P&L/risk tracking.
          console.log(`WARNING: contract ${contractId} is_sold=true but profit/sell_price unusable - treating as unresolved, will retry next poll.`);
          resolve({ isSold: false, profit: 0 });
          return;
        }
        resolve({
          isSold: !!contract.is_sold,
          profit: computedProfit,
          buyPrice: contract.buy_price,
          sellPrice: contract.sell_price,
          status: contract.status
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

// Recovers from a previous run dying mid-trade. Checks for a leftover
// active trade marker; if one exists with a contract ID and has had
// enough time to settle, queries Deriv directly for what actually
// happened and records the REAL outcome instead of losing it silently.
async function reconcileOrphanedTrade(token, app_id, strategyName) {
  const active = await memory.getActiveTrade(strategyName);
  if (!active) return;

  const ageMs = Date.now() - new Date(active.placedAt).getTime();

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

  // digit_differ places multiple contracts atomically within one
  // invocation over a single batched connection
  // (placeDigitDifferBatchAndWait) and normally records every result and
  // clears its own marker before this function's caller runs again - a
  // leftover marker here means that invocation died mid-batch. Shape
  // check (active.contractIds is an array) mirrors accumulator's
  // growthRate check above.
  if (Array.isArray(active.contractIds)) {
    return await reconcileOrphanedDigitDifferBatch(token, app_id, strategyName, active, ageMs);
  }

  // Shouldn't happen under normal operation - every current strategy's
  // active-trade marker matches one of the shapes above. Defensively
  // clear anything unrecognized once it's been stale a while instead of
  // letting it block new trades forever.
  if (ageMs > 5 * 60 * 1000) {
    console.log(`WARNING: Unrecognized orphaned active trade marker (${strategyName}), age ${(ageMs / 1000).toFixed(0)}s - clearing.`);
    await memory.appendLog(strategyName, 'Unrecognized orphaned trade marker cleared', 'pause');
    await memory.clearActiveTrade(strategyName);
  }
}

// Digit Differ places N contracts (one per excluded digit) at once, so
// a crashed-mid-batch marker needs every contract accounted for before
// anything gets recorded - see placeDigitDifferBatchAndWait's own
// comment for why partial recording would be unsafe (recordAndLogTrade
// clears the WHOLE active-trade marker on its first call, which would
// silently drop the remaining unresolved contract IDs from tracking).
// So: query every contract's status first, and only record (all of
// them, using the locally-held digits/contractIds - immune to the
// marker being cleared mid-loop) once EVERY one has actually settled.
async function reconcileOrphanedDigitDifferBatch(token, app_id, strategyName, active, ageMs) {
  if (ageMs < 30000) return; // still could be genuinely in-flight

  const validIds = active.contractIds.filter((id) => id);
  if (validIds.length < active.contractIds.length) {
    // Didn't even get contract IDs for every bet - some buys may never
    // have gone through. Same grace period as a pre-buy crash elsewhere.
    if (ageMs > 5 * 60 * 1000) {
      console.log(`WARNING: Orphaned digit-differ batch missing ${active.contractIds.length - validIds.length} contract IDs (${strategyName}) - clearing, outcome unknown.`);
      await memory.appendLog(strategyName, 'Orphaned digit-differ batch cleared (incomplete, outcome unknown)', 'pause');
      await memory.clearActiveTrade(strategyName);
    }
    return;
  }

  console.log(`Reconciling orphaned digit-differ batch: ${validIds.length} contracts, age ${(ageMs / 1000).toFixed(0)}s`);
  const statuses = [];
  let allSold = true;
  for (const contractId of validIds) {
    try {
      const auth = await getOtpWebSocketUrl(token, app_id);
      const status = await queryContractStatus(auth.wsUrl, contractId);
      statuses.push(status);
      if (!status.isSold) allSold = false;
    } catch (err) {
      console.log(`WARNING: Could not check digit-differ contract ${contractId}: ${err.message}`);
      allSold = false;
      statuses.push(null);
    }
  }

  if (!allSold) {
    if (ageMs > 10 * 60 * 1000) {
      console.log(`WARNING: Digit-differ batch still unresolved after ${(ageMs / 60000).toFixed(1)}m (${strategyName}) - clearing, some outcomes may be unrecorded.`);
      await memory.appendLog(strategyName, 'Digit-differ batch cleared after prolonged unresolved state', 'pause');
      await memory.clearActiveTrade(strategyName);
    } else {
      console.log('Orphaned digit-differ batch still settling - will check again next run.');
    }
    return;
  }

  let wonCount = 0;
  for (let i = 0; i < statuses.length; i++) {
    const { won, profit } = wonFromStatus(statuses[i], active.stake);
    if (won) wonCount++;
    await recordAndLogTrade(strategyName, `DIFF≠${active.digits[i]}`, active.symbol, active.stake, { won, profit }, null, null, undefined, 'digit_differ');
  }
  console.log(`Recovered orphaned digit-differ batch: ${wonCount}/${statuses.length} won`);
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
      symbols.forEach((symbol, i) => {
        ws.send(JSON.stringify({
          ticks_history: symbol,
          style: 'ticks',
          count: count,
          end: 'latest',
          req_id: i
        }));
      });
    };

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);
      const i = res.req_id;
      if (i === undefined || i === null) return; // unrelated message
      const symbol = symbols[i];
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

// Resolves one settled contract's won/profit from a proposal_open_contract
// push, sharing the same fallback logic across every place that needs
// it: contract.status ('won'/'lost') is the authoritative outcome when
// present, since trusting profit > 0 alone means an unusable/zero
// profit reading gets misread as a loss even on an actual win. A
// fallback of profit: 0 on an unresolvable read once made a real loss
// silently vanish from P&L (displayed as a false "+$0.00", undercounted
// dailyLoss/stop-loss tracking) - falling back to -stake on a confirmed
// loss instead is the safe direction to be wrong in, since it can't
// hide a loss the way defaulting to 0 did.
function resolveSettledContract(contract, stake) {
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
  return { won, profit, contractId: contract.contract_id, buyPrice: contract.buy_price, sellPrice: contract.sell_price };
}

// Same "trust status over a possibly-unusable profit read" logic as
// resolveSettledContract above, but for the { isSold, profit, status }
// shape queryContractStatus returns - kept in sync so the same profit>0
// edge case (a 0/NaN profit read on an actual win getting misread as a
// loss) doesn't stay live on the accumulator/force-sell/orphan-recovery
// paths that all go through queryContractStatus instead of a raw buy response.
function wonFromStatus(status, stake) {
  const won = status.status ? status.status === 'won' : status.profit > 0;
  let profit = status.profit;
  if (!Number.isFinite(profit)) {
    profit = won ? 0 : -stake;
  }
  return { won, profit };
}

// Places N Digit Differ contracts (one per excluded digit) over a
// SINGLE WebSocket connection and waits for all of them to settle,
// instead of one connection per bet - same batching principle as
// connectAndGetTicksForSymbols (tick fetches), applied to buys, so
// stacking multiple digits doesn't multiply the connection/auth load
// per run. bets: [{ digit, stake, symbol, duration, duration_unit }].
// onEachBought(index, contractId) fires as soon as EACH buy confirms,
// before any of them settle, so the caller can persist contract IDs for
// crash recovery without waiting on the slowest one.
function placeDigitDifferBatchAndWait(wsUrl, bets, onEachBought) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let resolved = false;
    const results = new Array(bets.length).fill(null);
    const contractIds = new Array(bets.length).fill(null);
    let settledCount = 0;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch (e) {}
        for (let i = 0; i < bets.length; i++) {
          if (!results[i]) {
            results[i] = { error: 'Timeout waiting for trade to settle', contractPlaced: !!contractIds[i], contractId: contractIds[i] };
          }
        }
        resolve(results);
      }
    }, 20000);

    ws.onopen = () => {
      bets.forEach((bet, i) => {
        ws.send(JSON.stringify({
          buy: 1,
          price: bet.stake,
          parameters: {
            contract_type: 'DIGITDIFF',
            underlying_symbol: bet.symbol,
            duration: bet.duration,
            duration_unit: bet.duration_unit,
            basis: 'stake',
            amount: bet.stake,
            currency: 'USD',
            barrier: String(bet.digit)
          },
          req_id: i
        }));
      });
    };

    function maybeResolve() {
      if (settledCount >= bets.length && !resolved) {
        clearTimeout(timeout);
        resolved = true;
        ws.close();
        resolve(results);
      }
    }

    ws.onmessage = (event) => {
      const res = JSON.parse(event.data);
      const i = res.req_id;

      if (res.error) {
        if (i !== undefined && results[i] === null) {
          results[i] = { error: res.error.message, contractPlaced: !!contractIds[i] };
          settledCount++;
          maybeResolve();
        }
        return;
      }

      if (res.msg_type === 'buy' && i !== undefined) {
        const contractId = res.buy.contract_id;
        contractIds[i] = contractId;
        if (onEachBought) {
          try { onEachBought(i, contractId); } catch (e) { console.log('onEachBought callback error:', e.message); }
        }
        ws.send(JSON.stringify({
          proposal_open_contract: 1,
          contract_id: contractId,
          subscribe: 1,
          req_id: i
        }));
        return;
      }

      if (res.msg_type === 'proposal_open_contract') {
        const contract = res.proposal_open_contract;
        // Match by contract_id, not req_id - this is a subscription
        // push and Deriv doesn't reliably echo req_id on every update.
        const idx = contractIds.indexOf(contract.contract_id);
        if (idx === -1 || results[idx] !== null) return;

        if (contract.is_sold) {
          results[idx] = resolveSettledContract(contract, bets[idx].stake);
          settledCount++;
          maybeResolve();
        }
      }
    };

    ws.onerror = (err) => {
      if (!resolved) {
        clearTimeout(timeout);
        resolved = true;
        for (let i = 0; i < bets.length; i++) {
          if (!results[i]) results[i] = { error: 'WS Error: ' + err.message, contractPlaced: !!contractIds[i], contractId: contractIds[i] };
        }
        resolve(results);
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
async function forceSellAndWait(token, app_id, contractId, stake) {
  const sellAuth = await getOtpWebSocketUrl(token, app_id);
  const sellResult = await sendSellRequest(sellAuth.wsUrl, contractId);
  if (sellResult.error) return { error: sellResult.error };

  try {
    const statusAuth = await getOtpWebSocketUrl(token, app_id);
    const status = await queryContractStatus(statusAuth.wsUrl, contractId);
    // The contract was just explicitly sold above, so it IS genuinely
    // closed on Deriv's side even if this status query itself couldn't
    // confirm the outcome yet (queryContractStatus reports that case as
    // isSold: false - see its own comment). Trusting status.profit
    // directly here would resolve won: false, profit: NaN on that gap -
    // return an error instead so the caller's existing "will retry next
    // run" handling re-queries rather than recording a fabricated result.
    if (!status.isSold) {
      return { error: 'Sell confirmed but outcome not yet confirmable - will retry next run' };
    }
    return wonFromStatus(status, stake);
  } catch (err) {
    return { error: err.message };
  }
}

module.exports.pickHybridBucket = pickHybridBucket;
