// test/strategy_accumulator.test.js
// Exercises the accumulator entry gate in
// netlify/functions/strategy_accumulator.js with no I/O.

const strategy = require('../netlify/functions/strategy_accumulator');
const { makeFlatCandles, makeTrendingCandles } = require('./helpers');

module.exports = {
  'refuses to enter when there is not enough candle history'(assert) {
    const result = strategy.getEntryDecision(makeFlatCandles(5, 100), { adxPeriod: 14 });
    assert.strictEqual(result.canEnter, false);
    assert.strictEqual(result.adx, null);
  },

  'enters on a calm/flat market (ADX 0)'(assert) {
    const result = strategy.getEntryDecision(makeFlatCandles(40, 100), { adxPeriod: 14, adxMaxEntry: 20 });
    assert.strictEqual(result.adx, 0);
    assert.strictEqual(result.canEnter, true, `expected calm market to clear the gate, got: ${result.reason}`);
  },

  'refuses to enter on a strongly trending market (ADX 100)'(assert) {
    const result = strategy.getEntryDecision(makeTrendingCandles(40, 100, 0.5), { adxPeriod: 14, adxMaxEntry: 20 });
    assert.strictEqual(result.adx, 100);
    assert.strictEqual(result.canEnter, false, `expected a strong trend to be blocked (survival-focused gate), got: ${result.reason}`);
  },

  'respects a custom adxMaxEntry ceiling'(assert) {
    const flat = makeFlatCandles(40, 100);
    // ADX 0 should clear literally any non-negative ceiling, including 0 itself.
    const result = strategy.getEntryDecision(flat, { adxPeriod: 14, adxMaxEntry: 0 });
    assert.strictEqual(result.canEnter, true);
  }
};
