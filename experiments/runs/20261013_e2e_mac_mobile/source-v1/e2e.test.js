'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlan, REQUESTERS, RECORDS, ACTIONS, PURPOSES } = require('./plan');
const {
  adviceDecision, checkTrail, parseInstrumentation, percentile, summarize, endToEndMs,
} = require('./lib');

test('the plan is fixed by its seed and holds distinct, balanced requests', () => {
  const plan = buildPlan({ seed: 20261013, perConfig: 30 });
  const again = buildPlan({ seed: 20261013, perConfig: 30 });
  assert.equal(plan.sha256, again.sha256);
  assert.notEqual(plan.sha256, buildPlan({ seed: 7, perConfig: 30 }).sha256);
  assert.equal(plan.items.length, 60);

  const scopes = new Set(plan.items.map((item) => [item.username, item.recordId, item.action, item.purpose].join('|')));
  assert.equal(scopes.size, 60, 'no request scope is used twice');
  assert.equal(new Set(plan.items.map((item) => item.id)).size, 60);
  assert.equal(new Set(plan.items.map((item) => item.justification)).size, 60, 'every prompt differs');

  for (const config of ['mac', 'mobile']) {
    const items = plan.items.filter((item) => item.config === config);
    assert.equal(items.length, 30);
    const count = (key, values) => values.map((value) => items.filter((item) => item[key] === value).length);
    // Both halves carry the same mix, so their stage times are comparable.
    assert.ok(count('username', REQUESTERS.map((r) => r.username)).every((n) => n >= 2 && n <= 3));
    assert.ok(count('recordId', RECORDS).every((n) => n === 10));
    assert.ok(count('action', ACTIONS).every((n) => n === 10));
    assert.ok(count('purpose', PURPOSES).every((n) => n === 5));
  }
  assert.ok(plan.items.every((item) => item.justification.includes(item.id)));
  assert.ok(plan.items.every((item) => !REQUESTERS.find((r) => r.username === item.username).org.includes('audit')));
});

test('a plan cannot ask for more distinct requests than exist', () => {
  assert.throws(() => buildPlan({ seed: 1, perConfig: 400 }), /distinct/);
});

test('percentiles use the nearest rank on the sorted values', () => {
  const values = [50, 10, 40, 20, 30];
  assert.equal(percentile(values, 50), 30);
  assert.equal(percentile(values, 95), 50);
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile([7], 95), 7);
  assert.throws(() => percentile([], 50), /no values/);
  assert.deepEqual(summarize(values), { n: 5, min: 10, median: 30, mean: 30, p95: 50, max: 50 });
  assert.deepEqual(summarize([1, 2, null, undefined, 3]).n, 3, 'missing values are not counted as zero');
  assert.equal(summarize([]), null);
});

test('the automated auditor follows only a committed, verified recommendation', () => {
  const ready = { recommendationState: 'committed', integrity: 'verified', generationStatus: 'OK' };
  assert.deepEqual(adviceDecision({ ...ready, recommendation: 'ALLOW' }), { decision: 'FORCE_ALLOW', followed: true });
  assert.deepEqual(adviceDecision({ ...ready, recommendation: 'DENY' }), { decision: 'FORCE_DENY', followed: true });
  for (const broken of [
    { ...ready, recommendation: 'ALLOW', integrity: 'mismatch' },
    { ...ready, recommendation: 'ALLOW', generationStatus: 'INVALID_OUTPUT' },
    { ...ready, recommendation: 'ALLOW', recommendationState: 'commit-rejected' },
    { ...ready, recommendation: 'MAYBE' },
    { ...ready, recommendation: null },
  ]) {
    const chosen = adviceDecision(broken);
    assert.equal(chosen.decision, 'FORCE_DENY');
    assert.equal(chosen.followed, false);
    assert.ok(chosen.reason.length > 10, 'a decision without advice carries a reason');
  }
});

function trailFixture(overrides = {}) {
  const event = (seq, eventType, txId, timestamp) => ({ seq, eventType, txId, timestamp });
  return {
    requestId: 'REQ-1',
    request: { requestId: 'REQ-1', status: 'granted', outcomeId: 'OUTCOME-9' },
    lifecycle: [
      event(1, 'ACCESS_REQUEST_SUBMITTED', 'tx-a', '2026-10-13T10:00:00.000Z'),
      event(2, 'DYNAMIC_AUTHORIZATION_CHECKED', 'tx-a', '2026-10-13T10:00:00.000Z'),
      event(3, 'RECOMMENDATION_COMMITTED', 'tx-b', '2026-10-13T10:00:10.000Z'),
      event(4, 'AUDITOR_DECISION_RECORDED', 'tx-c', '2026-10-13T10:00:20.000Z'),
      event(5, 'AGREEMENT_DERIVED', 'tx-c', '2026-10-13T10:00:20.000Z'),
      event(6, 'ACCESS_OUTCOME_RECORDED', 'tx-c', '2026-10-13T10:00:20.000Z'),
    ],
    recommendationCommitment: { recommendation: 'ALLOW', generationStatus: 'OK', txId: 'tx-b' },
    auditorDecision: {
      decision: 'FORCE_ALLOW', llmRecommendation: 'ALLOW', llmAgreement: 'AGREED',
      auditor: { username: 'sp.north' }, txId: 'tx-c',
    },
    accessOutcome: { outcome: 'GRANTED', outcomeId: 'OUTCOME-9', basis: 'AUDITOR_DECISION', txId: 'tx-c' },
    offChainVerification: {
      justification: { status: 'verified' }, recommendation: { status: 'verified' }, note: { status: 'not-committed' },
    },
    ...overrides,
  };
}
const expected = { requestId: 'REQ-1', decision: 'FORCE_ALLOW', auditor: 'sp.north', outcomeId: 'OUTCOME-9' };
const failed = (checks) => checks.filter((check) => !check.ok).map((check) => check.name);

test('a complete reviewed workflow passes every ledger check', () => {
  assert.deepEqual(failed(checkTrail(trailFixture(), expected)), []);
  assert.equal(checkTrail(trailFixture(), expected).length, 9);
});

test('each ledger fault is caught by its own check', () => {
  const broken = (overrides) => failed(checkTrail(trailFixture(overrides), expected));
  const base = trailFixture();
  assert.deepEqual(broken({ lifecycle: base.lifecycle.filter((e) => e.eventType !== 'RECOMMENDATION_COMMITTED') }),
    ['lifecycle stages are complete and in order']);
  assert.deepEqual(broken({ lifecycle: [base.lifecycle[2], ...base.lifecycle.filter((_, i) => i !== 2)] }),
    ['lifecycle stages are complete and in order']);
  assert.deepEqual(broken({
    lifecycle: base.lifecycle.map((e) => (e.eventType === 'ACCESS_OUTCOME_RECORDED' ? { ...e, txId: 'tx-z' } : e)),
  }), ['decision, agreement and outcome share one transaction']);
  assert.deepEqual(broken({ auditorDecision: { ...base.auditorDecision, decision: 'FORCE_DENY' } }),
    ['the ledger holds the decision that was sent', 'the outcome follows from the decision',
      'the agreement follows from the committed recommendation']);
  assert.deepEqual(broken({ auditorDecision: { ...base.auditorDecision, llmAgreement: 'NOT_AGREED' } }),
    ['the agreement follows from the committed recommendation']);
  assert.deepEqual(broken({ auditorDecision: { ...base.auditorDecision, auditor: { username: 'sp.south' } } }),
    ['the decision is recorded under the auditor who made it']);
  assert.deepEqual(broken({ accessOutcome: { ...base.accessOutcome, outcomeId: 'OUTCOME-1' } }),
    ['the outcome is the one the auditor was shown']);
  assert.deepEqual(broken({
    offChainVerification: { ...base.offChainVerification, recommendation: { status: 'mismatch' } },
  }), ['off-chain justification and recommendation match their ledger digests']);
  assert.deepEqual(broken({ request: { ...base.request, status: 'denied' } }), ['the request status matches the outcome']);
});

test('a decision without a recommendation is checked as such', () => {
  const none = trailFixture({
    recommendationCommitment: { recommendation: 'ALLOW', generationStatus: 'INVALID_OUTPUT', txId: 'tx-b' },
    auditorDecision: {
      decision: 'FORCE_DENY', llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION',
      auditor: { username: 'sp.north' }, txId: 'tx-c',
    },
    accessOutcome: { outcome: 'DENIED', outcomeId: 'OUTCOME-9', basis: 'AUDITOR_DECISION', txId: 'tx-c' },
    request: { requestId: 'REQ-1', status: 'denied', outcomeId: 'OUTCOME-9' },
  });
  assert.deepEqual(failed(checkTrail(none, { ...expected, decision: 'FORCE_DENY' })), []);
});

test('the instrumentation result is read from its last lines', () => {
  assert.deepEqual(parseInstrumentation('\norg.dias.mobile.X:.\n\nTime: 4.2\n\nOK (1 test)\n'),
    { ok: true, tests: 1, detail: 'OK (1 test)' });
  const failure = parseInstrumentation('X:\nError in a(X):\njava.lang.AssertionError: boom\n\nFAILURES!!!\nTests run: 1,  Failures: 1\n');
  assert.equal(failure.ok, false);
  assert.match(failure.detail, /AssertionError: boom/);
  assert.equal(parseInstrumentation('INSTRUMENTATION_RESULT: shortMsg=Process crashed.\n').ok, false);
  assert.equal(parseInstrumentation('OK (0 tests)').ok, false, 'a run that executed nothing is not a pass');
});

test('the end-to-end time is the sum of the processing stages, with none missing', () => {
  const row = { submitMs: 2000, recommendationMs: 9000, queueMs: 100, reviewMs: 50, decisionMs: 2100, readbackMs: 40, logMs: 60 };
  assert.equal(endToEndMs(row), 13290);
  assert.equal(endToEndMs({ ...row, reviewMs: null }), null);
});

const { STAGES, stageTable, runSummary, phoneDifference } = require('./analyze');

function finished(overrides = {}) {
  return {
    status: 'completed', config: 'mac', submitMs: 2000, recommendationMs: 8000, modelInferenceMs: 6500,
    queueMs: 20, reviewMs: 15, decisionMs: 2000, readbackMs: 10, logMs: 50, requesterReadbackMs: 9,
    endToEndMs: 12045, advice: 'ALLOW', recommendation: 'ALLOW', policyAnswer: 'ALLOW', adviceMatchesPolicy: true,
    followed: true, outcome: 'GRANTED', ledgerOk: true, requesterOk: true, logOk: true,
    checks: [{ name: 'a', ok: true }, { name: 'b', ok: true }], ...overrides,
  };
}

test('the stage table counts completed workflows only and joins the decision with its readback', () => {
  const rows = [
    finished(), finished({ decisionMs: 1800, readbackMs: 12, submitMs: 1000, endToEndMs: 10847 }),
    finished({ status: 'check-failed', submitMs: 99999 }), { status: 'failed', stage: 'submit' },
  ];
  const table = stageTable(rows);
  assert.deepEqual(table.map((line) => line.key),
    STAGES.map((stage) => stage.key).filter((key) => key !== 'phoneSignIn'));
  const stage = (key) => table.find((line) => line.key === key);
  assert.equal(stage('submit').n, 2);
  assert.equal(stage('submit').max, 2000, 'a workflow that failed a check is left out');
  assert.deepEqual([stage('decision').min, stage('decision').max], [1812, 2010]);
  assert.equal(stage('endToEnd').median, 10847);
  assert.equal(stage('phoneSignIn'), undefined, 'a stage nobody measured is left out, not shown as zero');
  assert.ok(stageTable([finished({ phoneSignInMs: 700 })]).some((line) => line.key === 'phoneSignIn'));
});

test('the run summary counts outcomes, advice and checks without hiding failures', () => {
  const rows = [
    finished(), finished({ advice: 'DENY', recommendation: 'DENY', policyAnswer: 'DENY', outcome: 'DENIED' }),
    finished({ advice: 'ALLOW', recommendation: 'ALLOW', policyAnswer: 'DENY', adviceMatchesPolicy: false }),
    finished({ status: 'check-failed', ledgerOk: false, checks: [{ name: 'a', ok: false }, { name: 'b', ok: true }] }),
    { status: 'failed', stage: 'recommendation', error: 'timeout' },
  ];
  assert.deepEqual(runSummary(rows, { planned: 6 }), {
    planned: 6, ran: 5, completed: 3, checkFailed: 1, failed: 1, notRun: 1,
    granted: 3, denied: 1, adviceAllow: 3, adviceDeny: 1, adviceFollowed: 4,
    adviceMatchesPolicy: 3, adviceCompared: 4,
    ledgerChecksPassed: 7, ledgerChecksMade: 8, failedStages: { recommendation: 1 },
  });
});

test('the phone difference compares medians of the auditor stages only', () => {
  const mac = stageTable([finished(), finished()]);
  const phone = stageTable([
    finished({ config: 'mobile', queueMs: 60, reviewMs: 65, decisionMs: 1900, readbackMs: 0, logMs: 110 }),
  ]);
  assert.deepEqual(phoneDifference(mac, phone), [
    { key: 'queue', macMedian: 20, phoneMedian: 60, differenceMs: 40 },
    { key: 'review', macMedian: 15, phoneMedian: 65, differenceMs: 50 },
    { key: 'decision', macMedian: 2010, phoneMedian: 1900, differenceMs: -110 },
    { key: 'log', macMedian: 50, phoneMedian: 110, differenceMs: 60 },
  ]);
});
