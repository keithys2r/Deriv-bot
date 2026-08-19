// supervisor-core.test.js
// Covers the pure, no-I/O parts of supervisor-core.js: the cheap
// skip-check comparison, response parsing (including fail-closed
// behavior on malformed/unexpected model output), and proposed-change
// validation (which reuses settings.js's real validators, not a mock).

const {
  buildSkipCheckSnapshot,
  shouldReview,
  parseSupervisorResponse,
  validateProposedChange,
  ALLOWED_PROPOSAL_KINDS
} = require('../netlify/functions/supervisor-core');

module.exports = {
  'buildSkipCheckSnapshot reads trades/net-profit/error-log fields'(assert) {
    const state = { tradesToday: 3, dailyProfit: 12, dailyLoss: 4 };
    const errorLog = [{ time: '2026-08-19T10:00:00.000Z', message: 'x' }];
    const snapshot = buildSkipCheckSnapshot(state, errorLog);
    assert.strictEqual(snapshot.tradesToday, 3);
    assert.strictEqual(snapshot.netProfit, 8);
    assert.strictEqual(snapshot.errorLogLen, 1);
    assert.strictEqual(snapshot.lastErrorTime, '2026-08-19T10:00:00.000Z');
  },

  'buildSkipCheckSnapshot handles empty error log and zeroed state'(assert) {
    const snapshot = buildSkipCheckSnapshot({}, []);
    assert.strictEqual(snapshot.tradesToday, 0);
    assert.strictEqual(snapshot.netProfit, 0);
    assert.strictEqual(snapshot.errorLogLen, 0);
    assert.strictEqual(snapshot.lastErrorTime, null);
  },

  'shouldReview returns false on first-ever run (no baseline yet)'(assert) {
    const snapshot = buildSkipCheckSnapshot({ tradesToday: 1, dailyProfit: 5, dailyLoss: 0 }, []);
    assert.strictEqual(shouldReview(null, snapshot, false), false);
  },

  'shouldReview returns true when a pending item just expired, even with nothing else changed'(assert) {
    const snapshot = buildSkipCheckSnapshot({ tradesToday: 1, dailyProfit: 5, dailyLoss: 0 }, []);
    assert.strictEqual(shouldReview(snapshot, snapshot, true), true);
  },

  'shouldReview returns false when nothing changed'(assert) {
    const snapshot = buildSkipCheckSnapshot({ tradesToday: 2, dailyProfit: 5, dailyLoss: 1 }, []);
    assert.strictEqual(shouldReview(snapshot, snapshot, false), false);
  },

  'shouldReview trips on a new trade'(assert) {
    const prev = buildSkipCheckSnapshot({ tradesToday: 2, dailyProfit: 5, dailyLoss: 1 }, []);
    const next = buildSkipCheckSnapshot({ tradesToday: 3, dailyProfit: 6, dailyLoss: 1 }, []);
    assert.strictEqual(shouldReview(prev, next, false), true);
  },

  'shouldReview trips on a new error'(assert) {
    const prev = buildSkipCheckSnapshot({ tradesToday: 2, dailyProfit: 5, dailyLoss: 1 }, []);
    const next = buildSkipCheckSnapshot({ tradesToday: 2, dailyProfit: 5, dailyLoss: 1 }, [{ time: 't1', message: 'oops' }]);
    assert.strictEqual(shouldReview(prev, next, false), true);
  },

  'parseSupervisorResponse fails closed on malformed JSON'(assert) {
    const result = parseSupervisorResponse('not json at all');
    assert.strictEqual(result.action, 'none');
    assert.ok(result.parseError);
  },

  'parseSupervisorResponse fails closed on an unrecognized action'(assert) {
    const result = parseSupervisorResponse(JSON.stringify({ action: 'delete_everything' }));
    assert.strictEqual(result.action, 'none');
    assert.ok(result.parseError);
  },

  'parseSupervisorResponse fails closed on report/question missing a message'(assert) {
    const result = parseSupervisorResponse(JSON.stringify({ action: 'report' }));
    assert.strictEqual(result.action, 'none');
    assert.ok(result.parseError);
  },

  'parseSupervisorResponse fails closed on propose_change with an out-of-allowlist kind'(assert) {
    const result = parseSupervisorResponse(JSON.stringify({
      action: 'propose_change',
      proposed_change: { kind: 'derivToken', value: 'steal-me' }
    }));
    assert.strictEqual(result.action, 'none');
    assert.ok(result.parseError);
  },

  'parseSupervisorResponse accepts a valid report'(assert) {
    const result = parseSupervisorResponse(JSON.stringify({ action: 'report', message: 'all quiet' }));
    assert.strictEqual(result.action, 'report');
    assert.strictEqual(result.message, 'all quiet');
  },

  'parseSupervisorResponse accepts a valid propose_change'(assert) {
    const result = parseSupervisorResponse(JSON.stringify({
      action: 'propose_change',
      message: 'stake looks high given the losing streak',
      proposed_change: { kind: 'stakeAmount', value: 1, reasoning: 'streak' }
    }));
    assert.strictEqual(result.action, 'propose_change');
    assert.strictEqual(result.proposed_change.kind, 'stakeAmount');
  },

  'validateProposedChange rejects a stake above the 20% clamp (reuses settings.js, not a copy)'(assert) {
    const result = validateProposedChange('stakeAmount', 10, { dailyStopLoss: 15 });
    assert.strictEqual(result.ok, false);
  },

  'validateProposedChange accepts a stake within the clamp'(assert) {
    const result = validateProposedChange('stakeAmount', 2, { dailyStopLoss: 15 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.value, 2);
  },

  'validateProposedChange rejects an invalid strategy name'(assert) {
    const result = validateProposedChange('activeStrategy', 'moon_landing', {});
    assert.strictEqual(result.ok, false);
  },

  'validateProposedChange accepts a valid strategy name'(assert) {
    const result = validateProposedChange('activeStrategy', 'digit_differ', {});
    assert.strictEqual(result.ok, true);
  },

  'validateProposedChange rejects a non-boolean manualPause'(assert) {
    const result = validateProposedChange('manualPause', 'yes', {});
    assert.strictEqual(result.ok, false);
  },

  'validateProposedChange rejects any kind outside the allowlist'(assert) {
    const result = validateProposedChange('derivToken', 'anything', {});
    assert.strictEqual(result.ok, false);
    assert.ok(!ALLOWED_PROPOSAL_KINDS.includes('derivToken'));
  }
};
