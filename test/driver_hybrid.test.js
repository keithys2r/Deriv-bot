// test/driver_hybrid.test.js
// Exercises driver.js's pickHybridBucket - the pure ADX-to-strategy
// routing decision behind runHybridStrategy - and isDailyStakeLimitError,
// the pure substring match behind the daily-stake-limit Telegram alert.
// No I/O involved in either.

const driver = require('../netlify/functions/driver');

module.exports = {
  'isDailyStakeLimitError: matches known Deriv rejection phrasings'(assert) {
    assert.strictEqual(driver.isDailyStakeLimitError('You have reached the maximum daily stake limit for this contract type'), true);
    assert.strictEqual(driver.isDailyStakeLimitError('Daily limit exceeded for this account'), true);
    assert.strictEqual(driver.isDailyStakeLimitError('Maximum stake per trade is 100.00'), true);
  },

  'isDailyStakeLimitError: does not match unrelated rejections'(assert) {
    assert.strictEqual(driver.isDailyStakeLimitError('Insufficient balance'), false);
    assert.strictEqual(driver.isDailyStakeLimitError('This contract is not available for this symbol'), false);
  },

  'isDailyStakeLimitError: handles missing/empty input'(assert) {
    assert.strictEqual(driver.isDailyStakeLimitError(undefined), false);
    assert.strictEqual(driver.isDailyStakeLimitError(''), false);
  },

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
