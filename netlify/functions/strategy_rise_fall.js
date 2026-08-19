// strategy_rise_fall.js
// Signal logic for Rise/Fall trades.
// This file does NOT connect to Deriv, does NOT place trades, and does
// NOT persist anything between runs - it's a pure function of whatever
// candle data and params it's given. Regime hysteresis (which needs to
// remember state between runs) lives in memory.js/driver.js instead;
// this file just needs to be TOLD the current regime and ADX value.
//
// One mode, regime-based:
//   TREND regime -> continuous EMA direction (which side EMA is on
//     right now, not just the crossing moment), gated by an ADX floor
//     so it won't trade a "trend" that's actually too weak.
//   RANGE regime -> RSI mean-reversion (oversold/overbought).
// A prior "classic" fresh-crossover mode and a RANGE-mode bias filter
// existed here too, but were removed as unneeded complexity for a
// contract that only needs to survive 3-5 ticks - recoverable from git
// history if ever wanted back.

const STRATEGY_NAME = 'rise_fall';

// ---- Tunable defaults ----
const EMA_FAST_PERIOD = 9;
const EMA_SLOW_PERIOD = 21;
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;
// ---------------------------

function calculateEMA(closes, period) {
  const k = 2 / (period + 1);
  const emaArray = new Array(closes.length).fill(null);
  if (closes.length < period) return emaArray;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  emaArray[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    emaArray[i] = closes[i] * k + emaArray[i - 1] * (1 - k);
  }
  return emaArray;
}

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

// ADX (trend strength, 0-100) from real OHLC candles. Ported from the
// old bot's simplified version but using true range (high/low/prevClose)
// since our candles have real high/low data, not just a flat price series.
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

  const smTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  const smPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  const smMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);

  if (smTR === 0) return 0;
  const pdi = (smPDM / smTR) * 100;
  const mdi = (smMDM / smTR) * 100;
  const sum = pdi + mdi;
  if (sum === 0) return 0;

  return parseFloat((Math.abs(pdi - mdi) / sum * 100).toFixed(1));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function getSignal(closes, params) {
  params = params || {};
  const emaFastPeriod = params.emaFastPeriod || EMA_FAST_PERIOD;
  const emaSlowPeriod = params.emaSlowPeriod || EMA_SLOW_PERIOD;
  const rsiPeriod = params.rsiPeriod || RSI_PERIOD;
  const rsiOverbought = params.rsiOverbought || RSI_OVERBOUGHT;
  const rsiOversold = params.rsiOversold || RSI_OVERSOLD;

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
  const fastNow = emaFast[lastIndex];
  const slowNow = emaSlow[lastIndex];
  const rsiNow = rsi[lastIndex];

  if (fastNow === null || slowNow === null || rsiNow === null) {
    return { signal: null, reason: 'Indicators not ready yet', details: null };
  }

  const details = { emaFast: fastNow, emaSlow: slowNow, rsi: rsiNow };

  const regime = params.regime || 'range'; // computed + persisted externally by memory.js
  const adx = params.adx;
  details.regime = regime;
  details.adx = adx;

  if (regime === 'trend') {
    const adxFloorTrend = params.adxFloorTrend ?? 25;
    if (adx !== null && adx !== undefined && adx < adxFloorTrend) {
      return {
        signal: null,
        reason: `TREND regime but ADX ${adx.toFixed(1)} below floor ${adxFloorTrend} - too weak to trust`,
        details
      };
    }
    // Continuous direction signal - no fresh-cross requirement, fires
    // as long as fast EMA is on this side of slow EMA.
    const direction = fastNow > slowNow ? 'CALL' : 'PUT';
    // How far above the "trust this trend" floor, scaled 0-1 - NOT
    // directly comparable to a raw ADX number across regimes, since
    // TREND is defined as high ADX and RANGE as low ADX by construction.
    // A watchlist scanner picking "highest confidence" instead of
    // "highest ADX" needs a scale that means the same thing in both
    // regimes - see the RANGE branch below for its own version of this.
    details.confidence = (adx !== null && adx !== undefined) ? clamp01((adx - adxFloorTrend) / (100 - adxFloorTrend)) : 0;
    return {
      signal: direction,
      reason: `TREND regime: EMA${emaFastPeriod} ${direction === 'CALL' ? 'above' : 'below'} EMA${emaSlowPeriod} (ADX ${adx !== null && adx !== undefined ? adx.toFixed(1) : '—'})`,
      details
    };
  } else {
    const adxFloorRange = params.adxFloorRange ?? 0;
    if (adxFloorRange > 0 && adx !== null && adx !== undefined && adx < adxFloorRange) {
      return {
        signal: null,
        reason: `RANGE regime but ADX ${adx.toFixed(1)} below floor ${adxFloorRange}`,
        details
      };
    }

    let sig = null;
    if (rsiNow < rsiOversold) sig = 'CALL';
    else if (rsiNow > rsiOverbought) sig = 'PUT';

    if (!sig) {
      return {
        signal: null,
        reason: `RANGE regime: RSI ${rsiNow.toFixed(1)} neutral (need under ${rsiOversold} or over ${rsiOverbought})`,
        details
      };
    }

    // How far RSI has pushed past the oversold/overbought threshold,
    // scaled 0-1 - the RANGE-side equivalent of the TREND branch's ADX
    // scaling above, so the two are comparable on the same footing
    // instead of a watchlist scan always favoring whichever candidate
    // happens to be in TREND (see driver.js's candidate sort).
    details.confidence = sig === 'CALL'
      ? clamp01((rsiOversold - rsiNow) / rsiOversold)
      : clamp01((rsiNow - rsiOverbought) / (100 - rsiOverbought));

    return {
      signal: sig,
      reason: `RANGE regime: RSI ${rsiNow.toFixed(1)} ${sig === 'CALL' ? 'oversold' : 'overbought'} - mean-reversion`,
      details
    };
  }
}

module.exports = {
  STRATEGY_NAME,
  getSignal,
  calculateEMA,
  calculateRSI,
  calculateADX,
  EMA_FAST_PERIOD,
  EMA_SLOW_PERIOD,
  RSI_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD
};
