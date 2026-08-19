// indicators.js
// Shared pure indicator math with no single owning strategy. Extracted
// from the former strategy_rise_fall.js when Rise/Fall was removed -
// calculateADX is still needed by strategy_accumulator.js's entry gate
// and by hybrid's own market read in driver.js, neither of which is
// "Rise/Fall logic" so it doesn't belong bundled with a specific
// strategy file. No I/O, no persistence.

// ADX (trend strength, 0-100) from real OHLC candles. Ported from an
// earlier version of this bot but using true range (high/low/prevClose)
// since these candles have real high/low data, not just a flat price series.
function calculateADX(candles, period) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 1) return null;

  const r = candles.slice(-(period * 2 + 1));
  const trs = [], pdm = [], mdm = [];

  for (let i = 1; i < r.length; i++) {
    const high = r[i].high, low = r[i].low;
    const prevHigh = r[i - 1].high, prevLow = r[i - 1].low, prevClose = r[i - 1].close;

    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);

    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mdm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smTR = trs.slice(-period).reduce((a, b) => a + b, 0);
  const smPDM = pdm.slice(-period).reduce((a, b) => a + b, 0);
  const smMDM = mdm.slice(-period).reduce((a, b) => a + b, 0);

  if (smTR === 0) return 0;
  const pdi = (smPDM / smTR) * 100;
  const mdi = (smMDM / smTR) * 100;
  const sum = pdi + mdi;
  if (sum === 0) return 0;

  return parseFloat((Math.abs(pdi - mdi) / sum * 100).toFixed(1));
}

module.exports = {
  calculateADX
};
