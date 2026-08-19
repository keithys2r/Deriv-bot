// test/driver_hybrid.test.js
// Exercises driver.js's pickHybridBucket - the pure ADX-to-strategy
// routing decision behind runHybridStrategy. No I/O involved.

const driver = require('../netlify/functions/driver');

module.exports = {
  'pickHybridBucket: calm ADX picks accumulator'(assert) {
    const r = driver.pickHybridBucket(15, 20);
    assert.strictEqual(r.picked, 'accumulator');
  },

  'pickHybridBucket: not-calm ADX picks digit_differ'(assert) {
    const r = driver.pickHybridBucket(40, 20);
    assert.strictEqual(r.picked, 'digit_differ');
  },

  'pickHybridBucket: null ADX (not enough history) picks digit_differ'(assert) {
    const r = driver.pickHybridBucket(null, 20);
    assert.strictEqual(r.picked, 'digit_differ');
    assert.ok(/n\/a/i.test(r.reason), `expected reason to show "n/a" ADX, got: ${r.reason}`);
  },

  'pickHybridBucket: boundary value is inclusive (accumulator wins ties)'(assert) {
    assert.strictEqual(driver.pickHybridBucket(20, 20).picked, 'accumulator'); // <= ceiling
    assert.strictEqual(driver.pickHybridBucket(21, 20).picked, 'digit_differ'); // just above ceiling
  }
};
