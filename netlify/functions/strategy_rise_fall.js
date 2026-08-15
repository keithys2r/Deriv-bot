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
// Input: array of closing prices, oldest first, most recent last.
// Output: { signal: 'CALL' | 'PUT' | null, reason: string, details: {...} }
function getSignal(closes) {
  const minCandles = Math.max(EMA_SLOW_PERIOD, RSI_PERIOD + 1) + 1;

  if (!Array.isArray(closes) || closes.length < minCandles) {
    return {
      signal: null,
      reason: `Not enough candle data (need ${minCandles}, got ${closes ? closes.length : 0})`,
      details: null
    };
  }

  const emaFast = calculateEMA(closes, EMA_FAST_PERIOD);
  const emaSlow = calculateEMA(closes, EMA_SLOW_PERIOD);
  const rsi = calculateRSI(closes, RSI_PERIOD);

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
  const bullishCross = fastPrev <= slowPrev && fastNow > slowNow;
  if (bullishCross && rsiNow < RSI_OVERBOUGHT) {
    return {
      signal: 'CALL',
      reason: `EMA${EMA_FAST_PERIOD} crossed above EMA${EMA_SLOW_PERIOD}, RSI ${rsiNow.toFixed(1)} (not overbought)`,
      details
    };
  }

  // Bearish confluence: fast EMA just crossed below slow EMA, RSI not oversold
  const bearishCross = fastPrev >= slowPrev && fastNow < slowNow;
  if (bearishCross && rsiNow > RSI_OVERSOLD) {
    return {
      signal: 'PUT',
      reason: `EMA${EMA_FAST_PERIOD} crossed below EMA${EMA_SLOW_PERIOD}, RSI ${rsiNow.toFixed(1)} (not oversold)`,
      details
    };
  }

  return {
    signal: null,
    reason: 'No fresh crossover with RSI confirmation this candle',
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
