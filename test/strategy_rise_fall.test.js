// test/strategy_rise_fall.test.js
// Exercises the pure indicator math and signal logic in
// netlify/functions/strategy_rise_fall.js with no I/O.

const strategy = require('../netlify/functions/strategy_rise_fall');
const { makeFlatCandles, makeTrendingCandles } = require('./helpers');

module.exports = {
  'calculateEMA holds steady on a flat price series'(assert) {
    const closes = new Array(30).fill(100);
    const ema = strategy.calculateEMA(closes, 9);
    assert.strictEqual(ema[8], 100, 'seed EMA (simple average of first period) should be 100');
    assert.strictEqual(ema[29], 100, 'EMA of a constant series should stay at that constant');
  },

  'calculateRSI reads 100 on an unbroken uptrend, 0 on an unbroken downtrend'(assert) {
    const up = [];
    for (let i = 0; i < 20; i++) up.push(100 + i);
    const rsiUp = strategy.calculateRSI(up, 14);
    assert.strictEqual(rsiUp[19], 100, 'all gains, no losses -> RSI 100');

    const down = [];
    for (let i = 0; i < 20; i++) down.push(100 - i);
    const rsiDown = strategy.calculateRSI(down, 14);
    assert.strictEqual(rsiDown[19], 0, 'all losses, no gains -> RSI 0');
  },

  'calculateADX reads 0 on a flat market, 100 on a clean trend'(assert) {
    const flat = makeFlatCandles(40, 100);
    assert.strictEqual(strategy.calculateADX(flat, 14), 0, 'no price movement -> ADX 0');

    const trending = makeTrendingCandles(40, 100, 0.5);
    assert.strictEqual(strategy.calculateADX(trending, 14), 100, 'one-directional movement every candle -> ADX 100');
  },

  'calculateADX returns null when there is not enough history'(assert) {
    const tooShort = makeFlatCandles(10, 100);
    assert.strictEqual(strategy.calculateADX(tooShort, 14), null);
  },

  'getSignal reports not-enough-data instead of guessing'(assert) {
    const result = strategy.getSignal([100, 101, 102], { emaSlowPeriod: 21, rsiPeriod: 14 });
    assert.strictEqual(result.signal, null);
    assert.ok(/not enough candle data/i.test(result.reason), `expected an insufficient-data reason, got: ${result.reason}`);
  },

  'adaptive TREND regime follows the EMA side once ADX clears the floor'(assert) {
    const trending = makeTrendingCandles(60, 100, 0.5);
    const closes = trending.map((c) => c.close);
    const result = strategy.getSignal(closes, {
      useAdaptiveRegime: true,
      regime: 'trend',
      adx: 90,
      adxFloorTrend: 25,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      rsiPeriod: 14
    });
    assert.strictEqual(result.signal, 'CALL', `rising closes with fast EMA above slow EMA should signal CALL, got: ${result.reason}`);
    // confidence = (adx - adxFloorTrend) / (100 - adxFloorTrend) = (90-25)/(100-25)
    assert.ok(Math.abs(result.details.confidence - 0.8667) < 0.001, `expected confidence ~0.867, got ${result.details.confidence}`);
  },

  'adaptive TREND regime refuses to trade when ADX is below the floor'(assert) {
    const trending = makeTrendingCandles(60, 100, 0.5);
    const closes = trending.map((c) => c.close);
    const result = strategy.getSignal(closes, {
      useAdaptiveRegime: true,
      regime: 'trend',
      adx: 10,
      adxFloorTrend: 25,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      rsiPeriod: 14
    });
    assert.strictEqual(result.signal, null);
    assert.ok(/too weak to trust/i.test(result.reason), `expected an ADX-too-weak reason, got: ${result.reason}`);
  },

  'adaptive RANGE regime fires a mean-reversion CALL on oversold RSI'(assert) {
    // Flat history so RSI has settled near neutral, then a sharp recent
    // drop to force it oversold - constructs a deterministic RSI < 30
    // without needing to hand-tune a crossover candle.
    const flatCloses = new Array(30).fill(100);
    const dropCloses = [];
    for (let i = 1; i <= 5; i++) dropCloses.push(100 - i * 2);
    const closes = flatCloses.concat(dropCloses);

    const result = strategy.getSignal(closes, {
      useAdaptiveRegime: true,
      regime: 'range',
      adx: 15,
      biasEnabled: false,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30
    });
    assert.strictEqual(result.signal, 'CALL', `sharp drop should read as oversold -> CALL, got: ${result.reason}`);
  },

  'confidence is comparable across regimes, not tied to raw ADX magnitude'(assert) {
    // A deeply oversold RANGE read (RSI near 0) should score a HIGH
    // confidence despite RANGE being "low ADX" by definition, while a
    // TREND read that only just clears its ADX floor should score a LOW
    // confidence despite "trend" sounding more decisive. This is the
    // actual bug being fixed: driver.js's watchlist scanner used to sort
    // candidates by raw ADX, which mathematically always favors TREND
    // (defined as high ADX) over RANGE (defined as low ADX) - confidence
    // puts them on the same 0-1 footing instead.
    const flatCloses = new Array(30).fill(100);
    const crashCloses = [];
    for (let i = 1; i <= 8; i++) crashCloses.push(100 - i * 5); // deep, fast drop
    const rangeResult = strategy.getSignal(flatCloses.concat(crashCloses), {
      useAdaptiveRegime: true,
      regime: 'range',
      adx: 15,
      biasEnabled: false,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      rsiPeriod: 14,
      rsiOverbought: 70,
      rsiOversold: 30
    });

    const trending = makeTrendingCandles(60, 100, 0.5);
    const barelyTrendResult = strategy.getSignal(trending.map((c) => c.close), {
      useAdaptiveRegime: true,
      regime: 'trend',
      adx: 26, // barely above the floor
      adxFloorTrend: 25,
      emaFastPeriod: 9,
      emaSlowPeriod: 21,
      rsiPeriod: 14
    });

    assert.strictEqual(rangeResult.signal, 'CALL');
    assert.strictEqual(barelyTrendResult.signal, 'CALL');
    assert.ok(
      rangeResult.details.confidence > barelyTrendResult.details.confidence,
      `expected the deep oversold RANGE read (${rangeResult.details.confidence}) to outrank the barely-qualifying TREND read (${barelyTrendResult.details.confidence})`
    );
  }
};
