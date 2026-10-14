'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPlan, digestOf, scopeOf, REQUESTERS, RECORDS, ACTIONS, PURPOSES } = require('./plan');
const {
  adviceDecision, checkTrail, parseInstrumentation, percentile, summarize, endToEndMs, waitForQuiet,
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
  assert.equal(digestOf(plan), plan.sha256, 'the digest can be recomputed from the plan itself');
  assert.notEqual(digestOf({ ...plan, items: plan.items.slice(1) }), plan.sha256);
});

test('the running order alternates the two halves and lets either go first', () => {
  const plan = buildPlan({ seed: 20261014, perConfig: 24, prefix: 'E2Q' });
  const config = new Map(plan.items.map((item) => [item.id, item.config]));
  assert.equal(plan.order.length, 48);
  assert.deepEqual([...plan.order].sort(), plan.items.map((item) => item.id).sort());
  const pairs = Array.from({ length: 24 }, (_, index) => plan.order.slice(index * 2, index * 2 + 2).map((id) => config.get(id)));
  assert.ok(pairs.every((pair) => pair.includes('mac') && pair.includes('mobile')), 'every pair holds one of each');
  const macFirst = pairs.filter((pair) => pair[0] === 'mac').length;
  assert.ok(macFirst >= 6 && macFirst <= 18, `neither half always runs first (mac first in ${macFirst} of 24)`);
  for (const half of ['mac', 'mobile']) {
    const ids = plan.order.filter((id) => config.get(id) === half);
    assert.deepEqual(ids, [...ids].sort(), 'each half keeps its own numbering order');
  }
  assert.ok(plan.items.every((item) => item.id.startsWith('E2Q-')));
});

test('a very small plan still draws a different request for each half', () => {
  // With one request per half, the first value of every list must not be the only choice.
  for (let seed = 1; seed <= 20; seed += 1) {
    const plan = buildPlan({ seed, perConfig: 1, exclude: ['const.verma|REC-FIR-001|view|investigation'] });
    assert.equal(new Set(plan.items.map(scopeOf)).size, 2);
    assert.ok(!plan.items.map(scopeOf).includes('const.verma|REC-FIR-001|view|investigation'));
  }
  const users = new Set(Array.from({ length: 20 }, (_, seed) => buildPlan({ seed, perConfig: 1 }).items[0].username));
  assert.ok(users.size > 3, 'different seeds pick different officers');
});

test('a later plan never repeats a request scope of an earlier one', () => {
  const earlier = buildPlan({ seed: 20261013, perConfig: 30 });
  const used = earlier.items.map(scopeOf);
  const later = buildPlan({ seed: 20261014, perConfig: 24, prefix: 'E2Q', exclude: used });
  assert.equal(later.items.filter((item) => used.includes(scopeOf(item))).length, 0);
  assert.notEqual(later.sha256, buildPlan({ seed: 20261014, perConfig: 24, prefix: 'E2Q' }).sha256);
  assert.throws(() => buildPlan({ seed: 1, perConfig: 300, exclude: used }), /distinct/);
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
  assert.equal(percentile([4, 1, 3, 2], 50), 2, 'an even count takes the lower middle value, never an average');
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

test('a decision made when no commitment exists is checked against the shorter trail', () => {
  const base = trailFixture();
  const none = trailFixture({
    lifecycle: base.lifecycle.filter((event) => event.eventType !== 'RECOMMENDATION_COMMITTED'),
    recommendationCommitment: null,
    auditorDecision: {
      decision: 'FORCE_DENY', llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION',
      auditor: { username: 'sp.north' }, txId: 'tx-c',
    },
    accessOutcome: { outcome: 'DENIED', outcomeId: 'OUTCOME-9', basis: 'AUDITOR_DECISION', txId: 'tx-c' },
    request: { requestId: 'REQ-1', status: 'denied', outcomeId: 'OUTCOME-9' },
    offChainVerification: { justification: { status: 'verified' }, recommendation: { status: 'not-committed' } },
  });
  assert.deepEqual(failed(checkTrail(none, { ...expected, decision: 'FORCE_DENY' })), []);
  // With a commitment on the ledger, the same shorter trail is a fault.
  assert.deepEqual(failed(checkTrail({ ...none, recommendationCommitment: base.recommendationCommitment },
    { ...expected, decision: 'FORCE_DENY' })).slice(0, 1), ['lifecycle stages are complete and in order']);
});

/** A clock and a staging folder that the test moves by hand. */
function fakeLedger(counts) {
  let time = 0;
  let reads = 0;
  return {
    list: () => counts[Math.min(reads++, counts.length - 1)],
    now: () => time,
    sleep: async (ms) => { time += ms; },
    reads: () => reads,
  };
}

test('the ledger counts as quiet only when the staging folder stays empty', async () => {
  // Three events drain, the folder looks empty once, one more appears, then it stays empty.
  const busy = fakeLedger([3, 2, 1, 0, 1, 0, 0, 0]);
  const waited = await waitForQuiet({ ...busy, pollMs: 100, settleMs: 300 });
  assert.equal(waited, 800, 'the wait ends one settle period after the folder last emptied');
  const idle = fakeLedger([0, 0]);
  assert.equal(await waitForQuiet({ ...idle, pollMs: 100, settleMs: 300 }), 300);
  const stuck = fakeLedger([2]);
  await assert.rejects(waitForQuiet({ ...stuck, pollMs: 100, settleMs: 300, timeoutMs: 1000 }), /not quiet/);
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

const { STAGES, pooledTable, stageTable, runSummary, phoneDifference } = require('./analyze');

function finished(overrides = {}) {
  return {
    status: 'completed', config: 'mac', submitMs: 2000, recommendationMs: 8000, modelInferenceMs: 6500,
    queueMs: 20, reviewMs: 15, decisionMs: 2000, readbackMs: 10, logMs: 50, requesterReadbackMs: 9,
    endToEndMs: 12045, advice: 'ALLOW', policyAnswer: 'ALLOW', adviceMatchesPolicy: true,
    followed: true, outcome: 'GRANTED', ledgerOk: true, requesterOk: true, logOk: true,
    checks: [{ name: 'a', ok: true }, { name: 'b', ok: true }], ...overrides,
  };
}
/** A workflow whose model output was unusable: denied with a reason, and correct on the ledger. */
const withoutAdvice = (overrides = {}) => finished({
  followed: false, advice: null, policyAnswer: 'DENY', adviceMatchesPolicy: null, outcome: 'DENIED', ...overrides,
});

test('the stage table uses only completed workflows that had usable advice', () => {
  const rows = [
    finished(), finished({ decisionMs: 1800, readbackMs: 12, submitMs: 1000, endToEndMs: 10847 }),
    finished({ status: 'check-failed', submitMs: 99999 }), { status: 'failed', stage: 'submit' },
    withoutAdvice({ submitMs: 55555 }),
  ];
  const table = stageTable(rows);
  assert.deepEqual(table.map((line) => line.key),
    STAGES.map((stage) => stage.key).filter((key) => !['quietBeforeRequest', 'quietBeforeDecision'].includes(key)));
  const stage = (key) => table.find((line) => line.key === key);
  assert.equal(stage('submit').n, 2);
  assert.equal(stage('submit').max, 2000, 'a failed check and an unusable answer are both left out');
  assert.deepEqual([stage('decision').min, stage('decision').max], [1812, 2010], 'the decision is joined with its readback');
  assert.equal(stage('endToEnd').median, 10847);
  assert.equal(stage('quietBeforeDecision'), undefined, 'a stage nobody measured is left out, not shown as zero');
  assert.ok(stageTable([finished({ quietBeforeDecisionMs: 9000 })]).some((line) => line.key === 'quietBeforeDecision'));
});

test('the run summary counts outcomes, advice and checks without hiding failures', () => {
  const rows = [
    finished(), finished({ advice: 'DENY', policyAnswer: 'DENY', outcome: 'DENIED' }),
    finished({ advice: 'ALLOW', policyAnswer: 'DENY', adviceMatchesPolicy: false }),
    finished({ status: 'check-failed', ledgerOk: false, checks: [{ name: 'a', ok: false }, { name: 'b', ok: true }] }),
    withoutAdvice(),
    { status: 'failed', stage: 'recommendation', error: 'timeout' },
  ];
  assert.deepEqual(runSummary(rows, { planned: 7 }), {
    planned: 7, ran: 6, completed: 4, checkFailed: 1, failed: 1, notRun: 1,
    timed: 3, noUsableAdvice: 1, granted: 3, denied: 2, adviceAllow: 3, adviceDeny: 1, adviceFollowed: 4,
    adviceMatchesPolicy: 3, adviceCompared: 4,
    ledgerChecksPassed: 9, ledgerChecksMade: 10, failedStages: { recommendation: 1 },
  });
});

test('stages that do not depend on the auditor are pooled over both kinds of workflow', () => {
  const rows = [
    finished({ submitMs: 2000 }), finished({ config: 'mobile', submitMs: 2100 }),
    finished({ config: 'mobile', submitMs: 2200 }), withoutAdvice({ config: 'mobile', submitMs: 9999 }),
  ];
  const pooled = pooledTable(rows);
  assert.deepEqual(pooled.map((line) => line.key), ['submit', 'recommendation', 'inference']);
  assert.deepEqual([pooled[0].n, pooled[0].min, pooled[0].max], [3, 2000, 2200]);
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
