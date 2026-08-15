// strategy_digit.js
// Pure signal logic for Digit Differ trades.
// This file does NOT connect to Deriv and does NOT place trades.
//
// HONEST NOTE: synthetic volatility indices are RNG-driven and digits
// are close to uniformly distributed over time. There is no real
// statistical edge here - Digit Differ is chosen because it has the
// LOWEST VARIANCE of the digit contract types (roughly 90% win rate
// per trade, since you're betting a digit will NOT match one number),
// which means slower, steadier losses instead of violent swings - not
// because it wins over time. Deriv's built-in payout edge still applies.
//
// Approach: look at the last N ticks, find whichever digit has
// appeared MOST often in that window, and bet "Differ" against it
// (a common retail-bot heuristic - "fade the hot digit"). This does
// not create real edge on a uniform RNG feed; it's a rule for
// generating a consistent, testable signal, nothing more.

const STRATEGY_NAME = 'digit';

const DEFAULT_LOOKBACK = 20; // how many recent ticks to analyze

// Extracts the last digit of a tick price at a given decimal precision.
function getLastDigit(price, decimals) {
  const fixed = Number(price).toFixed(decimals);
  return parseInt(fixed.slice(-1), 10);
}

// Input: array of raw tick prices (oldest first, most recent last),
// and optional params { lookback, decimals }.
// Output: { signal: 'DIGITDIFF' | null, barrier: number | null, reason, details }
function getSignal(prices, params) {
  params = params || {};
  const lookback = params.lookback || DEFAULT_LOOKBACK;
  const decimals = params.decimals || 2;

  if (!Array.isArray(prices) || prices.length < lookback) {
    return {
      signal: null,
      barrier: null,
      reason: `Not enough tick data (need ${lookback}, got ${prices ? prices.length : 0})`,
      details: null
    };
  }

  const recent = prices.slice(-lookback);
  const digits = recent.map((p) => getLastDigit(p, decimals));

  const freq = new Array(10).fill(0);
  digits.forEach((d) => freq[d]++);

  let hottestDigit = 0;
  let hottestCount = freq[0];
  for (let d = 1; d <= 9; d++) {
    if (freq[d] > hottestCount) {
      hottestCount = freq[d];
      hottestDigit = d;
    }
  }

  return {
    signal: 'DIGITDIFF',
    barrier: hottestDigit,
    reason: `Digit ${hottestDigit} appeared ${hottestCount}/${lookback} times (most frequent) - betting Differ`,
    details: { frequency: freq, lookback }
  };
}

module.exports = {
  STRATEGY_NAME,
  getSignal,
  getLastDigit,
  DEFAULT_LOOKBACK
};
