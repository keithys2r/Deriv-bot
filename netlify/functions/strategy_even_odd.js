// strategy_even_odd.js
// Pure signal logic for Even/Odd trades (DIGITEVEN / DIGITODD).
// This file does NOT connect to Deriv and does NOT place trades.
//
// HONEST NOTE: a synthetic volatility index's last digit is close to
// uniformly distributed - 5 of 10 digits are even, 5 are odd - so this
// is close to the purest coin flip Deriv offers. There is no real
// statistical edge here, and Deriv's payout on a win is still less than
// 1:1, so even a perfectly fair 50/50 read loses money slowly over time.
// Same caveat the old Digit Differ strategy carried.
//
// Approach: look at the last N ticks, count how many had an even vs odd
// last digit, and bet AGAINST whichever parity has been more frequent
// (a common "fade the hot side" retail heuristic). This does not create
// real edge on a uniform-random digit feed; it's a rule for generating a
// consistent, testable signal, nothing more.

const STRATEGY_NAME = 'even_odd';

const DEFAULT_LOOKBACK = 20; // how many recent ticks to analyze

// Extracts the last digit of a tick price at a given decimal precision.
function getLastDigit(price, decimals) {
  const fixed = Number(price).toFixed(decimals);
  return parseInt(fixed.slice(-1), 10);
}

// Input: array of raw tick prices (oldest first, most recent last),
// and optional params { lookback, decimals }.
// Output: { signal: 'DIGITEVEN' | 'DIGITODD' | null, reason, details }
function getSignal(prices, params) {
  params = params || {};
  const lookback = params.lookback || DEFAULT_LOOKBACK;
  const decimals = params.decimals || 2;

  if (!Array.isArray(prices) || prices.length < lookback) {
    return {
      signal: null,
      reason: `Not enough tick data (need ${lookback}, got ${prices ? prices.length : 0})`,
      details: null
    };
  }

  const recent = prices.slice(-lookback);
  const digits = recent.map((p) => getLastDigit(p, decimals));

  let evenCount = 0;
  let oddCount = 0;
  digits.forEach((d) => {
    if (d % 2 === 0) evenCount++;
    else oddCount++;
  });

  // Fade the more frequent side. A tie has no "hot" side to fade against,
  // so no signal that run rather than picking one arbitrarily.
  let signal = null;
  if (evenCount > oddCount) signal = 'DIGITODD';
  else if (oddCount > evenCount) signal = 'DIGITEVEN';

  if (!signal) {
    return {
      signal: null,
      reason: `Even/odd split tied (${evenCount}/${oddCount}) over the last ${lookback} ticks - no hot side to fade`,
      details: { evenCount, oddCount, lookback }
    };
  }

  const hotSide = evenCount > oddCount ? 'EVEN' : 'ODD';
  const hotCount = Math.max(evenCount, oddCount);
  return {
    signal,
    reason: `${hotSide} appeared ${hotCount}/${lookback} times (more frequent) - betting ${signal === 'DIGITEVEN' ? 'EVEN' : 'ODD'}`,
    details: { evenCount, oddCount, lookback }
  };
}

module.exports = {
  STRATEGY_NAME,
  getSignal,
  getLastDigit,
  DEFAULT_LOOKBACK
};
