// test/strategy_even_odd.test.js
// Exercises the pure "fade the hot parity" heuristic in
// netlify/functions/strategy_even_odd.js with no I/O.

const strategy = require('../netlify/functions/strategy_even_odd');

module.exports = {
  'refuses to signal when there is not enough tick history'(assert) {
    const result = strategy.getSignal([1.23, 1.24], { lookback: 20 });
    assert.strictEqual(result.signal, null);
    assert.ok(/not enough tick data/i.test(result.reason));
  },

  'fades a run of even last digits by betting ODD'(assert) {
    // Last digits: 0,2,4,6,8,0,2,4,6,8 - all even.
    const prices = [1.10, 1.12, 1.14, 1.16, 1.18, 1.20, 1.22, 1.24, 1.26, 1.28];
    const result = strategy.getSignal(prices, { lookback: 10, decimals: 2 });
    assert.strictEqual(result.signal, 'DIGITODD', `expected to fade an all-even run, got: ${result.reason}`);
    assert.strictEqual(result.details.evenCount, 10);
    assert.strictEqual(result.details.oddCount, 0);
  },

  'fades a run of odd last digits by betting EVEN'(assert) {
    // Last digits: 1,3,5,7,9,1,3,5,7,9 - all odd.
    const prices = [1.11, 1.13, 1.15, 1.17, 1.19, 1.21, 1.23, 1.25, 1.27, 1.29];
    const result = strategy.getSignal(prices, { lookback: 10, decimals: 2 });
    assert.strictEqual(result.signal, 'DIGITEVEN', `expected to fade an all-odd run, got: ${result.reason}`);
  },

  'no signal on an exact tie - no hot side to fade'(assert) {
    // 5 even, 5 odd.
    const prices = [1.10, 1.11, 1.12, 1.13, 1.14, 1.15, 1.16, 1.17, 1.18, 1.19];
    const result = strategy.getSignal(prices, { lookback: 10, decimals: 2 });
    assert.strictEqual(result.signal, null);
    assert.ok(/tied/i.test(result.reason), `expected a tie reason, got: ${result.reason}`);
  },

  'getLastDigit reads the last digit at the given decimal precision'(assert) {
    assert.strictEqual(strategy.getLastDigit(123.456, 2), 6); // "123.46" -> 6
    assert.strictEqual(strategy.getLastDigit(1, 0), 1);
  }
};
