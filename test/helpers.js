// test/helpers.js
// Synthetic OHLC candle builders shared by the strategy test files, chosen
// specifically because their ADX comes out to a clean, deterministic
// value - see the comments on each for why, so tests don't rely on
// fuzzy/approximate assertions.

// Every candle identical -> zero true range beyond the fixed high/low
// offset, zero directional movement either way -> calculateADX returns
// exactly 0 (its own explicit `smTR === 0` / `sum === 0` early-outs).
function makeFlatCandles(n, price) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    candles.push({ open: price, high: price + 0.01, low: price - 0.01, close: price, epoch: i });
  }
  return candles;
}

// High and low both increase by the same fixed step every candle -> every
// move is a "positive directional movement" and never a "negative" one
// (see calculateADX's pdm/mdm logic), so +DI ends up at 100 and -DI at 0
// -> ADX comes out to exactly 100. A clean downtrend (decreasing step)
// produces the same 100 via the opposite (-DI) side - ADX measures trend
// STRENGTH, not direction, so both read as "strongly trending."
function makeTrendingCandles(n, start, step) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    price += step;
    const close = price;
    candles.push({
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      epoch: i
    });
  }
  return candles;
}

module.exports = { makeFlatCandles, makeTrendingCandles };
