// test/strategy_digit_differ.test.js
// Exercises the pure digit-selection logic in
// netlify/functions/strategy_digit_differ.js. No I/O.

const strategy = require('../netlify/functions/strategy_digit_differ');

module.exports = {
  'pickExcludedDigits: returns the requested count of digits'(assert) {
    assert.strictEqual(strategy.pickExcludedDigits(2, 0).length, 2);
    assert.strictEqual(strategy.pickExcludedDigits(1, 0).length, 1);
    assert.strictEqual(strategy.pickExcludedDigits(5, 0).length, 5);
  },

  'pickExcludedDigits: all returned digits are unique and in range 0-9'(assert) {
    const digits = strategy.pickExcludedDigits(4, 7);
    const unique = new Set(digits);
    assert.strictEqual(unique.size, digits.length, 'expected no duplicate digits');
    digits.forEach((d) => {
      assert.ok(d >= 0 && d <= 9, `digit ${d} out of range`);
    });
  },

  'pickExcludedDigits: clamps a below-range count to 1, an above-range count to 9'(assert) {
    // 0 is falsy in JS, so it hits the "not provided" fallback (same as
    // undefined) rather than the Math.max(1, ...) clamp - a negative
    // count is truthy and does exercise the real clamp path.
    assert.strictEqual(strategy.pickExcludedDigits(-5, 0).length, 1);
    assert.strictEqual(strategy.pickExcludedDigits(15, 0).length, 9);
  },

  'pickExcludedDigits: falls back to DEFAULT_EXCLUDE_COUNT when not provided'(assert) {
    assert.strictEqual(strategy.pickExcludedDigits(undefined, 0).length, strategy.DEFAULT_EXCLUDE_COUNT);
  },

  'pickExcludedDigits: rotation seed shifts which digits are picked, not how many'(assert) {
    const a = strategy.pickExcludedDigits(2, 0);
    const b = strategy.pickExcludedDigits(2, 5);
    assert.strictEqual(a.length, b.length);
    assert.deepStrictEqual(a, [0, 1]);
    assert.deepStrictEqual(b, [5, 6]);
  },

  'pickExcludedDigits: rotation wraps around past 9'(assert) {
    assert.deepStrictEqual(strategy.pickExcludedDigits(3, 8), [8, 9, 0]);
  },

  'pickExcludedDigits: negative rotation seed still wraps into 0-9'(assert) {
    const digits = strategy.pickExcludedDigits(2, -3);
    digits.forEach((d) => assert.ok(d >= 0 && d <= 9, `digit ${d} out of range`));
  }
};
