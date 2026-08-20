// test/memory.test.js
// Exercises memory.js's pure stake-scaling math (no Blobs I/O involved).

const memory = require('../netlify/functions/memory');

module.exports = {
  'getStakeScaleFactor: unchanged behavior at 0/50/80% weekly progress'(assert) {
    assert.strictEqual(memory.getStakeScaleFactor(0, 100), 1.0);
    assert.strictEqual(memory.getStakeScaleFactor(50, 100), 0.75);
    assert.strictEqual(memory.getStakeScaleFactor(80, 100), 0.5);
  },

  'getLosingStreakScaleFactor: no losses is a no-op'(assert) {
    assert.strictEqual(memory.getLosingStreakScaleFactor(0, 3), 1.0);
  },

  'getLosingStreakScaleFactor: ramps linearly toward the cooldown threshold'(assert) {
    assert.ok(Math.abs(memory.getLosingStreakScaleFactor(1, 3) - 0.8333) < 0.001);
    assert.ok(Math.abs(memory.getLosingStreakScaleFactor(2, 3) - 0.6667) < 0.001);
  },

  'getLosingStreakScaleFactor: floors at 0.5 at/past maxConsecutiveLosses'(assert) {
    assert.strictEqual(memory.getLosingStreakScaleFactor(3, 3), 0.5);
    assert.strictEqual(memory.getLosingStreakScaleFactor(10, 3), 0.5);
  },

  'getLosingStreakScaleFactor: disabled/invalid maxConsecutiveLosses is a no-op'(assert) {
    assert.strictEqual(memory.getLosingStreakScaleFactor(2, 0), 1.0);
    assert.strictEqual(memory.getLosingStreakScaleFactor(2, undefined), 1.0);
  },

  'getConfidenceScaleFactor: undefined confidence is a no-op (no current strategy produces one)'(assert) {
    assert.strictEqual(memory.getConfidenceScaleFactor(undefined), 1.0);
    assert.strictEqual(memory.getConfidenceScaleFactor(null), 1.0);
  },

  'getConfidenceScaleFactor: 0 confidence floors at 0.5, 1.0 confidence is full stake'(assert) {
    assert.strictEqual(memory.getConfidenceScaleFactor(0), 0.5);
    assert.strictEqual(memory.getConfidenceScaleFactor(1), 1.0);
  },

  'getConfidenceScaleFactor: 0.5 confidence lands at the midpoint'(assert) {
    assert.strictEqual(memory.getConfidenceScaleFactor(0.5), 0.75);
  },

  'getConfidenceScaleFactor: clamps out-of-range input'(assert) {
    assert.strictEqual(memory.getConfidenceScaleFactor(1.5), 1.0);
    assert.strictEqual(memory.getConfidenceScaleFactor(-1), 0.5);
  },

  'hourInSession: simple non-wrapping range (London 08-17)'(assert) {
    assert.strictEqual(memory.hourInSession(8, 8, 17), true);
    assert.strictEqual(memory.hourInSession(16, 8, 17), true);
    assert.strictEqual(memory.hourInSession(17, 8, 17), false); // end is exclusive
    assert.strictEqual(memory.hourInSession(7, 8, 17), false);
  },

  'hourInSession: midnight-wrapping range (Sydney 22-07)'(assert) {
    assert.strictEqual(memory.hourInSession(23, 22, 7), true);
    assert.strictEqual(memory.hourInSession(0, 22, 7), true);
    assert.strictEqual(memory.hourInSession(6, 22, 7), true);
    assert.strictEqual(memory.hourInSession(7, 22, 7), false); // end is exclusive
    assert.strictEqual(memory.hourInSession(12, 22, 7), false);
  },

  'hourInSession: overlapping sessions both match the same hour'(assert) {
    // 14:00 UTC falls in both London (08-17) and New York (13-22) -
    // the overlap is deliberate, not a bug (see SESSIONS' comment).
    const london = memory.SESSIONS.find((s) => s.key === 'london');
    const newyork = memory.SESSIONS.find((s) => s.key === 'newyork');
    assert.strictEqual(memory.hourInSession(14, london.start, london.end), true);
    assert.strictEqual(memory.hourInSession(14, newyork.start, newyork.end), true);
  }
};
