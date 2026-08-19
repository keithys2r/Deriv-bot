// strategy_accumulator.js
// Entry-gate logic for Accumulator contracts.
// This file does NOT connect to Deriv, does NOT place trades, and does
// NOT persist anything between runs - pure function of whatever candle
// data and params it's given, same shape as strategy_rise_fall.js.
//
// Accumulators aren't directional (no CALL/PUT) - the contract just
// accrues stake growth tick by tick until either the price breaches an
// implicit barrier (knockout, full stake lost) or it's cashed out via
// take-profit. So there's no "signal" to compute, only a survival-odds
// gate: enter when the market is calm (low ADX / ranging), since a
// volatile market breaches the barrier faster. Reuses the ADX calc
// already built for rise_fall instead of duplicating it.

const { calculateADX } = require('./strategy_rise_fall');

const STRATEGY_NAME = 'accumulator';
const DEFAULT_ADX_MAX_ENTRY = 20;

// Input: OHLC candles (same shape as strategy_rise_fall consumes) and
// params { adxPeriod, adxMaxEntry }.
// Output: { canEnter: boolean, reason, adx }
function getEntryDecision(candles, params) {
  params = params || {};
  const adxPeriod = params.adxPeriod || 14;
  const adxMaxEntry = params.adxMaxEntry ?? DEFAULT_ADX_MAX_ENTRY;

  const adx = calculateADX(candles, adxPeriod);

  if (adx === null || adx === undefined) {
    return { canEnter: false, reason: 'Not enough candle data to compute ADX yet', adx: null };
  }

  if (adx > adxMaxEntry) {
    return {
      canEnter: false,
      reason: `ADX ${adx.toFixed(1)} above entry ceiling ${adxMaxEntry} - too volatile for a good survival chance`,
      adx
    };
  }

  return {
    canEnter: true,
    reason: `ADX ${adx.toFixed(1)} at/below entry ceiling ${adxMaxEntry} - calm enough to enter`,
    adx
  };
}

// Converts a target tick-count into the equivalent take-profit
// percentage for a given growth rate - an accumulator's value grows by
// (1 + growthRate) per surviving tick, so N ticks of growth is
// (1 + growthRate)^N - 1. Lets a user target "cash out after ~N ticks"
// directly instead of hand-computing a percentage that goes stale if
// they change the growth rate later.
function ticksToTakeProfitPct(growthRate, ticks) {
  return Math.pow(1 + growthRate, ticks) - 1;
}

module.exports = {
  STRATEGY_NAME,
  getEntryDecision,
  DEFAULT_ADX_MAX_ENTRY,
  ticksToTakeProfitPct
};
