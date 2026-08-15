// strategy_rise_fall.js
// Pure signal logic for Rise/Fall trades using RSI + EMA confluence.
// This file does NOT connect to Deriv and does NOT place trades.
// It only takes candle data in, and returns a signal out.
// driver.js is responsible for fetching candles and calling this.

const STRATEGY_NAME = 'rise_fall';

// ---- Tunable settings ----
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
// ---------------------------

// Calculates EMA array for a given period from an array of closing prices.
// Returns an array same length as input, with early values as null
// until there's enough data to start the EMA.
function calculateEMA(closes, period) {
  const k = 2 / (period + 1);
  const emaArray = new Array(closes.length).fill(null);

  // Seed the first EMA value with a simple average of the first `period` closes
  if (closes.length < period) return emaArray;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  emaArray[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    emaArray[i] = closes[i] * k + emaArray[i - 1] * (1 - k);
  }

  return emaArray;
}

// Calculates RSI array using Wilder's smoothing method.
// Returns array same length as input, null until enough data exists.
function calculateRSI(closes, period) {
  const rsiArray = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsiArray;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  rsiArray[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsiArray[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return rsiArray;
}

// Main signal function.
// Input: array of closing prices (oldest first, most recent last), and
// an optional params object to override the defaults below - this is
// how user-configured settings (from the frontend) reach the strategy.
// Output: { signal: 'CALL' | 'PUT' | null, reason: string, details: {...} }
function getSignal(closes, params) {
  params = params || {};
  const emaFastPeriod = params.emaFastPeriod || EMA_FAST_PERIOD;
  const emaSlowPeriod = params.emaSlowPeriod || EMA_SLOW_PERIOD;
  const rsiPeriod = params.rsiPeriod || RSI_PERIOD;
  const rsiOverbought = params.rsiOverbought || RSI_OVERBOUGHT;
  const rsiOversold = params.rsiOversold || RSI_OVERSOLD;
  // Defaults to true (safer). Set to false to fire on EMA crossovers
  // alone, without waiting for RSI confirmation - useful for gathering
  // more trade samples faster, at the cost of the extra filter that
  // avoids buying into an already-overbought/oversold move.
  const requireRsiConfirmation = params.requireRsiConfirmation !== false;

  const minCandles = Math.max(emaSlowPeriod, rsiPeriod + 1) + 1;

  if (!Array.isArray(closes) || closes.length < minCandles) {
    return {
      signal: null,
      reason: `Not enough candle data (need ${minCandles}, got ${closes ? closes.length : 0})`,
      details: null
    };
  }

  const emaFast = calculateEMA(closes, emaFastPeriod);
  const emaSlow = calculateEMA(closes, emaSlowPeriod);
  const rsi = calculateRSI(closes, rsiPeriod);

  const lastIndex = closes.length - 1;
  const prevIndex = lastIndex - 1;

  const fastNow = emaFast[lastIndex];
  const slowNow = emaSlow[lastIndex];
  const fastPrev = emaFast[prevIndex];
  const slowPrev = emaSlow[prevIndex];
  const rsiNow = rsi[lastIndex];

  if (fastNow === null || slowNow === null || rsiNow === null) {
    return {
      signal: null,
      reason: 'Indicators not ready yet',
      details: null
    };
  }

  const details = {
    emaFast: fastNow,
    emaSlow: slowNow,
    rsi: rsiNow
  };

  // Bullish confluence: fast EMA just crossed above slow EMA, RSI not overbought
  // (unless RSI confirmation is turned off)
  const bullishCross = fastPrev <= slowPrev && fastNow > slowNow;
  if (bullishCross && (!requireRsiConfirmation || rsiNow < rsiOverbought)) {
    return {
      signal: 'CALL',
      reason: requireRsiConfirmation
        ? `EMA${emaFastPeriod} crossed above EMA${emaSlowPeriod}, RSI ${rsiNow.toFixed(1)} (not overbought)`
        : `EMA${emaFastPeriod} crossed above EMA${emaSlowPeriod} (RSI confirmation off, RSI ${rsiNow.toFixed(1)})`,
      details
    };
  }

  // Bearish confluence: fast EMA just crossed below slow EMA, RSI not oversold
  // (unless RSI confirmation is turned off)
  const bearishCross = fastPrev >= slowPrev && fastNow < slowNow;
  if (bearishCross && (!requireRsiConfirmation || rsiNow > rsiOversold)) {
    return {
      signal: 'PUT',
      reason: requireRsiConfirmation
        ? `EMA${emaFastPeriod} crossed below EMA${emaSlowPeriod}, RSI ${rsiNow.toFixed(1)} (not oversold)`
        : `EMA${emaFastPeriod} crossed below EMA${emaSlowPeriod} (RSI confirmation off, RSI ${rsiNow.toFixed(1)})`,
      details
    };
  }

  return {
    signal: null,
    reason: requireRsiConfirmation
      ? 'No fresh crossover with RSI confirmation this candle'
      : 'No fresh EMA crossover this candle',
    details
  };
}

module.exports = {
  STRATEGY_NAME,
  getSignal,
  calculateEMA,
  calculateRSI,
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  RSI_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD
};
