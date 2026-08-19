// strategy_digit_differ.js
// Digit Differ is NOT a directional strategy - there's no market signal
// to compute, no candles, no I/O. Winning is a fixed, known probability
// baked into the contract itself: betting the last digit of the next
// tick WON'T be one specific digit gives a 9/10 (90%) win probability
// per excluded digit, purely from there being 10 possible last digits
// (0-9), not from reading the market. Excluding multiple digits at once
// (separate simultaneous contracts, one per digit) raises the combined
// win probability further - each additional excluded digit removes
// another 1/10 of the outcome space - at the cost of a smaller payout
// per win. Deriv prices the payout to keep expected value in the
// house's favor regardless of which/how many digits get excluded, same
// skew as every other contract type in this codebase.
//
// Because win probability is fixed by the digit COUNT, not by any
// market read, WHICH digits get excluded doesn't affect the odds at
// all - this file picks them by simple rotation rather than pretending
// a clever heuristic adds real edge that isn't there.

const STRATEGY_NAME = 'digit_differ';
const DEFAULT_EXCLUDE_COUNT = 2;

// Returns which digits (0-9) to exclude this trade. Pure rotation
// through 0-9 driven by whatever seed the caller passes (e.g. a
// timestamp) - no statistical benefit over a fixed digit, just avoids
// the trade log looking suspiciously identical run after run.
function pickExcludedDigits(excludeCount, rotationSeed) {
  const count = Math.max(1, Math.min(9, excludeCount || DEFAULT_EXCLUDE_COUNT));
  const offset = ((rotationSeed || 0) % 10 + 10) % 10;
  const digits = [];
  for (let i = 0; i < count; i++) {
    digits.push((offset + i) % 10);
  }
  return digits;
}

module.exports = {
  STRATEGY_NAME,
  DEFAULT_EXCLUDE_COUNT,
  pickExcludedDigits
};
