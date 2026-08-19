// test/driver_hybrid.test.js
// Exercises driver.js's pickHybridBucket - the pure ADX-to-strategy
// routing decision behind runHybridStrategy. No I/O involved.

const driver = require('../netlify/functions/driver');

module.exports = {
  'pickHybridBucket: calm ADX picks accumulator'(assert) {
    const r = driver.pickHybridBucket(15, 20, 35);
    assert.strictEqual(r.picked, 'accumulator');
  },

  'pickHybridBucket: trending ADX picks rise_fall'(assert) {
    const r = driver.pickHybridBucket(40, 20, 35);
    assert.strictEqual(r.picked, 'rise_fall');
  },

  'pickHybridBucket: unclear middle zone now picks rise_fall, not even_odd'(assert) {
    const r = driver.pickHybridBucket(27, 20, 35);
    assert.strictEqual(r.picked, 'rise_fall');
    assert.ok(/unclear/i.test(r.reason), `expected reason to mention "unclear", got: ${r.reason}`);
  },

  'pickHybridBucket: null ADX (not enough history) picks rise_fall via the unclear branch'(assert) {
    const r = driver.pickHybridBucket(null, 20, 35);
    assert.strictEqual(r.picked, 'rise_fall');
    assert.ok(/n\/a/i.test(r.reason), `expected reason to show "n/a" ADX, got: ${r.reason}`);
  },

  'pickHybridBucket: boundary values are inclusive'(assert) {
    assert.strictEqual(driver.pickHybridBucket(20, 20, 35).picked, 'accumulator'); // <= ceiling
    assert.strictEqual(driver.pickHybridBucket(35, 20, 35).picked, 'rise_fall');   // >= floor
  }
};
