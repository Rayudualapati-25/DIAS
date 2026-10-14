'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIONS, PURPOSES, RECORDS, REQUESTERS, scopeOf } = require('./plan');
const {
  CELLS, DENIED_BASES, SETUPS, buildSetupPlan, digestOf, plannedRequests,
} = require('./setup-plan');

const tally = (values) => values.reduce((counts, value) => counts.set(value, (counts.get(value) || 0) + 1), new Map());
const plan = buildSetupPlan({ seed: 20261014 });

test('the plan is a pure function of its seed and carries its own digest', () => {
  assert.deepEqual(buildSetupPlan({ seed: 20261014 }), plan);
  assert.equal(digestOf(plan), plan.sha256);
  assert.notEqual(buildSetupPlan({ seed: 20261015 }).sha256, plan.sha256);
  assert.throws(() => buildSetupPlan({ seed: 1, perCell: 0 }), /positive whole numbers/);
});

test('no request scope and no justification is used twice in the plan, except a repeat of its own request', () => {
  const requests = plannedRequests(plan);
  const repeats = requests.filter((item) => /-(repeat\d|afterrevoke)$/.test(item.id));
  const others = requests.filter((item) => !repeats.includes(item));
  assert.equal(new Set(others.map(scopeOf)).size, others.length);
  assert.equal(new Set(requests.map((item) => item.justification)).size, requests.length);
  assert.equal(new Set(requests.map((item) => item.id)).size, requests.length);
  for (const item of requests) {
    assert.ok(REQUESTERS.some((requester) => requester.username === item.username));
    assert.ok(RECORDS.includes(item.recordId) && ACTIONS.includes(item.action) && PURPOSES.includes(item.purpose));
    assert.ok(item.justification.endsWith(`request ${item.id}.`));
  }
});

test('every cell of the step experiment has the same size and the same mix', () => {
  assert.equal(plan.steps.items.length, 96);
  for (const cell of CELLS) {
    const items = plan.steps.items.filter((item) => item.cell === cell.cell);
    assert.equal(items.length, 24);
    assert.ok(items.every((item) => item.officer === cell.officer && item.auditor === cell.auditor && item.setup === cell.setup));
    assert.deepEqual([...tally(items.map((item) => item.recordId)).values()], [8, 8, 8]);
    assert.deepEqual([...tally(items.map((item) => item.action)).values()], [8, 8, 8]);
    assert.deepEqual([...tally(items.map((item) => item.purpose)).values()], [4, 4, 4, 4, 4, 4]);
    assert.deepEqual([...tally(items.map((item) => item.username)).values()], Array(12).fill(2));
  }
});

test('the step experiment runs the four cells once per block, never in a fixed order', () => {
  const byId = new Map(plan.steps.items.map((item) => [item.id, item]));
  assert.equal(plan.steps.order.length, 96);
  assert.equal(new Set(plan.steps.order).size, 96);
  const blocks = Array.from({ length: 24 }, (_, block) => plan.steps.order.slice(block * 4, block * 4 + 4));
  for (const block of blocks) {
    assert.deepEqual(block.map((id) => byId.get(id).cell).sort(), ['MM', 'MP', 'PM', 'PP']);
  }
  const firsts = tally(blocks.map((block) => byId.get(block[0]).cell));
  assert.ok(firsts.size >= 3, 'the same cell does not always go first');
});

test('the reuse experiment deals denied requests evenly to the cells, each with repeats and two counter-checks', () => {
  assert.equal(plan.reuse.bases.length, 12);
  assert.deepEqual([...tally(plan.reuse.bases.map((base) => base.cell)).values()], [3, 3, 3, 3]);
  const known = new Set(DENIED_BASES.map((base) => base.join('|')));
  for (const base of plan.reuse.bases) {
    assert.ok(known.has([base.username, base.recordId, base.action].join('|')));
    assert.equal(scopeOf(base.first), scopeOf(base));
    assert.equal(base.repeats.length, 3);
    for (const repeat of [...base.repeats, base.afterRevoke]) assert.equal(scopeOf(repeat), scopeOf(base));
    // A near miss differs in the purpose alone, so only an exact-scope match may grant.
    assert.notEqual(base.nearMiss.purpose, base.purpose);
    assert.deepEqual({ ...base.nearMiss, purpose: base.purpose, id: 0, justification: 0 },
      { ...base.first, id: 0, justification: 0 });
  }
  assert.equal(new Set(plan.reuse.bases.map(scopeOf)).size, 12);
  assert.throws(() => buildSetupPlan({ seed: 1, basesPerCell: 4 }), /at most 3 reuse requests per cell/);
});

test('no step or load request asks for a file and operation the reuse experiment authorizes', () => {
  const reserved = new Set(DENIED_BASES.map((base) => base.join('|')));
  const others = plannedRequests(plan).filter((item) => item.experiment !== 'reuse');
  assert.ok(others.every((item) => !reserved.has([item.username, item.recordId, item.action].join('|'))));
});

test('the load experiment has one burst per setup, level and repeat, with officers spread evenly', () => {
  assert.equal(plan.load.bursts.length, 18);
  assert.equal(new Set(plan.load.bursts.map((burst) => `${burst.setup}|${burst.level}|${burst.repeat}`)).size, 18);
  for (const burst of plan.load.bursts) {
    assert.ok(SETUPS.includes(burst.setup) && [5, 10, 25].includes(burst.level) && [1, 2].includes(burst.repeat));
    assert.equal(burst.requests.length, burst.level);
    const perOfficer = [...tally(burst.requests.map((item) => item.username)).values()];
    assert.ok(Math.max(...perOfficer) - Math.min(...perOfficer) <= 1);
    assert.equal(perOfficer.length, Math.min(burst.level, 12));
    const surfaces = burst.requests.map((item) => item.officer);
    if (burst.setup === 'mac-only') assert.ok(surfaces.every((surface) => surface === 'mac'));
    if (burst.setup === 'phone-only') assert.ok(surfaces.every((surface) => surface === 'phone'));
    if (burst.setup === 'combined') assert.ok(surfaces.every((surface, index) => surface === (index % 2 === 0 ? 'mac' : 'phone')));
  }
  // Each repeat runs all nine kinds before the next repeat begins.
  assert.deepEqual(plan.load.bursts.slice(0, 9).map((burst) => burst.repeat), Array(9).fill(1));
  assert.deepEqual(plan.load.order, plan.load.bursts.map((burst) => burst.id));
});

test('a smaller plan keeps the same structure', () => {
  const small = buildSetupPlan({ seed: 7, perCell: 1, basesPerCell: 1, loadLevels: [2], loadRepeats: 1 });
  assert.equal(small.steps.items.length, 4);
  assert.equal(small.reuse.bases.length, 4);
  assert.equal(small.load.bursts.length, 3);
  assert.equal(plannedRequests(small).length, 4 + 4 * 6 + 3 * 2);
});

// --- the surfaces and the runners' rules ---------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const { encoded, newestEntry, submission } = require('./desks');
const { officerViewOk, options, selected, storeWatcher } = require('./setup-common');
const { auditorSeat, burstSummary, checkLogEntry, expectedAgreement } = require('./setup-load');
const { checkReuse } = require('./setup-reuse');

test('a submitted request is read the same way from either surface', () => {
  const waiting = submission({ httpStatus: 202, ms: 2100.26, data: { requestId: 'REQ-1', processingPath: 'auditor-review',
    dynamicAuthorizationCheck: { matched: false, authorizationId: null } } });
  assert.deepEqual(waiting, { submitMs: 2100.3, submitStatus: 202, requestId: 'REQ-1', automatic: false, authorizationId: null });
  const reused = submission({ httpStatus: 201, ms: 2000, data: { requestId: 'REQ-2', processingPath: 'dynamic-authorization',
    dynamicAuthorizationCheck: { matched: true, authorizationId: 'AUTH-7' } } });
  assert.deepEqual([reused.automatic, reused.authorizationId], [true, 'AUTH-7']);
  assert.throws(() => submission({ httpStatus: 422, error: 'case file does not exist', ms: 5 }), /submit 422: case file does not exist/);
  assert.throws(() => submission({ httpStatus: 202, data: {}, ms: 5 }), /no request id/);
});

test('free text for a phone command survives the shell and decodes to itself', () => {
  const text = 'Needed for the défense; "quoted" $HOME `x` & more.';
  assert.match(encoded(text), /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(encoded(text), 'base64url').toString('utf8'), text);
});

test('the newest log entry is the last decided, then the highest request number', () => {
  const entries = [
    { requestId: 'REQ-a', submittedAtUtc: '2026-10-14T01:00:00Z', decidedAtUtc: '2026-10-14T01:05:00Z' },
    { requestId: 'REQ-b', submittedAtUtc: '2026-10-14T01:04:00Z', decidedAtUtc: null },
    { requestId: 'REQ-c', submittedAtUtc: '2026-10-14T01:00:00Z', decidedAtUtc: '2026-10-14T01:05:00Z' },
  ];
  assert.equal(newestEntry(entries).requestId, 'REQ-c');
  assert.deepEqual(newestEntry([]), {});
});

test('the officer must be shown the outcome, and the explanation only after a denial that had advice', () => {
  const denied = { outcome: 'DENIED', advice: 'DENY', officerSees: 'DENIED', explanationShown: true };
  assert.equal(officerViewOk(denied), true);
  assert.equal(officerViewOk({ ...denied, explanationShown: false }), false);
  assert.equal(officerViewOk({ ...denied, officerSees: 'GRANTED' }), false);
  assert.equal(officerViewOk({ outcome: 'GRANTED', advice: 'ALLOW', officerSees: 'GRANTED', explanationShown: false }), true);
  assert.equal(officerViewOk({ outcome: 'GRANTED', advice: 'DENY', officerSees: 'GRANTED', explanationShown: true }), false);
  // A denial without any advice has no explanation to show.
  assert.equal(officerViewOk({ outcome: 'DENIED', advice: null, officerSees: 'DENIED', explanationShown: false }), true);
});

test('the store watcher reports when a new review was stored and last rewritten, and ignores what was there', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-watch-'));
  try {
    fs.writeFileSync(path.join(dir, 'REQ-old.json'), '{}');
    fs.mkdirSync(path.join(dir, 'access-events'));
    const watcher = storeWatcher(dir, { pollMs: 5 });
    assert.equal(watcher.createdAt('REQ-old'), null);
    fs.writeFileSync(path.join(dir, 'REQ-new.json.tmp'), '{}');
    assert.equal(watcher.createdAt('REQ-new'), null, 'a temporary file is not a stored review');
    fs.renameSync(path.join(dir, 'REQ-new.json.tmp'), path.join(dir, 'REQ-new.json'));
    const stored = watcher.createdAt('REQ-new');
    assert.ok(Number.isFinite(stored));
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.writeFileSync(path.join(dir, 'REQ-new.json'), '{"state":"committed"}');
    assert.equal(watcher.createdAt('REQ-new'), stored, 'the first time is kept when the review is rewritten');
    assert.ok(watcher.writtenAt('REQ-new') - stored >= 20);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runner options need the plan, the run folder and the staging folder', () => {
  assert.deepEqual(options(['--plan', 'p.json', '--out', 'o', '--staging', 's', '--limit', '3'], ['plan', 'out', 'staging'], 'usage'),
    { plan: 'p.json', out: 'o', staging: 's', limit: 3, only: null });
  assert.throws(() => options(['--plan', 'p.json'], ['plan', 'out', 'staging'], 'usage: x'), /usage: x/);
  // A trial run takes named entries, or the first few; a full run takes all, in the plan's order.
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(selected(entries, { limit: 0, only: null }), entries);
  assert.deepEqual(selected(entries, { limit: 2, only: null }).map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(selected(entries, options(['--only', 'c,a'], [], 'usage')).map((entry) => entry.id), ['a', 'c']);
});

test('in a burst the auditor sits where the setup says, alternating in the combined setup', () => {
  assert.deepEqual([0, 1, 2].map((turn) => auditorSeat('mac-only', turn)), ['mac', 'mac', 'mac']);
  assert.deepEqual([0, 1, 2].map((turn) => auditorSeat('phone-only', turn)), ['phone', 'phone', 'phone']);
  assert.deepEqual([0, 1, 2, 3].map((turn) => auditorSeat('combined', turn)), ['mac', 'phone', 'mac', 'phone']);
});

test('a decided request of a burst is checked against its entry in the reviewer log', () => {
  const row = { username: 'insp.sharma', recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
    decision: 'FORCE_DENY', outcome: 'DENIED', followed: true };
  const entry = { requester: { username: 'insp.sharma' }, recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
    decision: 'FORCE_DENY', auditor: { username: 'sp.north' }, outcome: 'DENIED', llmRecommendation: 'DENY',
    llmAgreement: 'AGREED', decisionTxId: 'tx1', outcomeTxId: 'tx1' };
  assert.ok(checkLogEntry(row, entry, 'sp.north').every((check) => check.ok));
  const failing = (change) => checkLogEntry(row, { ...entry, ...change }, 'sp.north').filter((check) => !check.ok).length;
  assert.equal(failing({ recordId: 'REC-OTHER' }), 1);
  assert.equal(failing({ auditor: { username: 'sp.south' } }), 1);
  assert.equal(failing({ outcome: 'GRANTED' }), 1);
  assert.equal(failing({ outcomeTxId: 'tx2' }), 1);
  // An agreement that does not follow from the advice fails twice: the rule, and "followed the advice".
  assert.equal(failing({ llmAgreement: 'NOT_AGREED' }), 2);
  assert.deepEqual(checkLogEntry(row, undefined, 'sp.north'), [{ name: 'the request is in the request log', ok: false }]);
  assert.equal(expectedAgreement('FORCE_ALLOW', 'DENY'), 'NOT_AGREED');
  assert.equal(expectedAgreement('FORCE_DENY', 'UNAVAILABLE'), 'NO_RECOMMENDATION');
});

test('a burst is summarized by when its last request was decided', () => {
  const burst = { id: 'L-mac-only-05-r1', setup: 'mac-only', level: 3, repeat: 1 };
  const rows = [
    { requestId: 'a', status: 'completed', submitMs: 2000, adviceReadyAfterMs: 9000, decidedAfterMs: 12000 },
    { requestId: 'b', status: 'completed', submitMs: 2200, adviceReadyAfterMs: 18000, decidedAfterMs: 30000 },
    { status: 'failed', error: 'submit 500' },
  ];
  const summary = burstSummary({ burst, rows, quietBeforeMs: 400, startedAtUtc: 'now', drainMs: 9000, checks: [] });
  assert.deepEqual([summary.requested, summary.accepted, summary.decided, summary.verified, summary.failed], [3, 2, 2, 2, 1]);
  assert.equal(summary.makespanMs, 30000);
  assert.equal(summary.decisionsPerMinute, 4);
  assert.equal(summary.decidedAfterMs.median, 21000, 'the two middle values are averaged');
  const none = burstSummary({ burst, rows: [rows[2]], quietBeforeMs: 0, startedAtUtc: 'now', drainMs: 0, checks: [] });
  assert.deepEqual([none.makespanMs, none.decisionsPerMinute, none.submitMs], [null, null, null]);
});

test('a reused request must show no advice, no auditor, and a grant by its own authorization', () => {
  const trail = { recommendationCommitment: null, auditorDecision: null,
    lifecycle: [{ eventType: 'ACCESS_REQUEST_SUBMITTED' }, { eventType: 'DYNAMIC_AUTHORIZATION_CHECKED' },
      { eventType: 'AUDITOR_REVIEW_SKIPPED' }, { eventType: 'ACCESS_OUTCOME_RECORDED' }],
    summary: { dynamicAuthorization: { outcome: 'MATCH' } } };
  const entry = { outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION', llmRecommendation: null, decision: null, authorizationId: 'AUTH-7' };
  assert.ok(checkReuse({ trail, entry, authorizationId: 'AUTH-7' }).every((check) => check.ok));
  assert.equal(checkReuse({ trail, entry, authorizationId: 'AUTH-8' }).filter((check) => !check.ok).length, 1);
  const advised = { ...trail, recommendationCommitment: { recommendation: 'DENY' } };
  assert.equal(checkReuse({ trail: advised, entry, authorizationId: 'AUTH-7' }).filter((check) => !check.ok).length, 1);
  assert.ok(checkReuse({ trail: undefined, entry: undefined, authorizationId: 'AUTH-7' }).every((check) => !check.ok));
});

// --- the ledger checks of an override -------------------------------------------------------

const { checkTrail } = require('./lib');

/** The trail of a grant against a committed DENY: one more stage, in the decision's transaction. */
function overrideTrail(change = {}) {
  const stage = (seq, eventType, txId) => ({ seq, eventType, txId, timestamp: `2026-10-14T01:00:0${seq}.000Z` });
  return {
    lifecycle: [
      stage(1, 'ACCESS_REQUEST_SUBMITTED', 'tx-a'), stage(2, 'DYNAMIC_AUTHORIZATION_CHECKED', 'tx-a'),
      stage(3, 'RECOMMENDATION_COMMITTED', 'tx-b'), stage(4, 'AUDITOR_DECISION_RECORDED', 'tx-c'),
      stage(5, 'AGREEMENT_DERIVED', 'tx-c'), stage(6, 'DYNAMIC_AUTHORIZATION_CREATED', 'tx-c'),
      stage(7, 'ACCESS_OUTCOME_RECORDED', 'tx-c'),
    ],
    recommendationCommitment: { recommendation: 'DENY', generationStatus: 'OK', txId: 'tx-b' },
    auditorDecision: { decision: 'FORCE_ALLOW', llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED',
      auditor: { username: 'sp.north' }, txId: 'tx-c', createdAuthorizationId: 'AUTH-7' },
    accessOutcome: { outcome: 'GRANTED', outcomeId: 'OUTCOME-1', txId: 'tx-c', createdAuthorizationId: 'AUTH-7' },
    offChainVerification: { justification: { status: 'verified' }, recommendation: { status: 'verified' } },
    request: { requestId: 'REQ-1', status: 'granted' },
    ...change,
  };
}

test('an override is checked with the authorization it creates, in the decision transaction', () => {
  const expected = { requestId: 'REQ-1', decision: 'FORCE_ALLOW', auditor: 'sp.north', outcomeId: 'OUTCOME-1',
    createdAuthorizationId: 'AUTH-7' };
  const failed = (trail, wanted = expected) => checkTrail(trail, wanted).filter((check) => !check.ok).map((check) => check.name);
  assert.deepEqual(failed(overrideTrail()), []);
  assert.equal(checkTrail(overrideTrail(), expected).length, 10);
  // The same trail, when no authorization was expected, has a stage too many.
  assert.deepEqual(failed(overrideTrail(), { ...expected, createdAuthorizationId: undefined }),
    ['lifecycle stages are complete and in order']);
  const base = overrideTrail();
  assert.deepEqual(failed(overrideTrail({ lifecycle: base.lifecycle.filter((e) => e.eventType !== 'DYNAMIC_AUTHORIZATION_CREATED') })),
    ['lifecycle stages are complete and in order', 'decision, agreement and outcome share one transaction']);
  assert.deepEqual(failed(overrideTrail({
    lifecycle: base.lifecycle.map((e) => (e.eventType === 'DYNAMIC_AUTHORIZATION_CREATED' ? { ...e, txId: 'tx-z' } : e)),
  })), ['decision, agreement and outcome share one transaction']);
  assert.deepEqual(failed(overrideTrail({ auditorDecision: { ...base.auditorDecision, createdAuthorizationId: 'AUTH-8' } })),
    ['the decision created the reusable authorization the auditor was shown']);
});

// --- clean-up after a failure ----------------------------------------------------------------

const { cleanUp } = require('./setup-reuse');
const { closeLeftovers } = require('./setup-load');

test('the reuse clean-up revokes only what this run created, and goes on after a failed revocation', async () => {
  const revoked = [];
  const client = {
    get: async () => ({ status: 200, data: [
      { authorizationId: 'AUTH-1', originatingRequestId: 'REQ-1' },
      { authorizationId: 'AUTH-9', originatingRequestId: 'REQ-2' },
      { authorizationId: 'AUTH-X', originatingRequestId: 'REQ-OF-SOMEONE-ELSE' },
    ] }),
    post: async (route) => {
      const id = route.split('/')[3];
      if (id === 'AUTH-1') throw new Error('connection lost');
      revoked.push(id);
      return { status: 200 };
    },
  };
  const checks = await cleanUp({ client, auditor: 'sp.north', created: new Set(['AUTH-1']), requestIds: new Set(['REQ-1', 'REQ-2']) });
  assert.deepEqual(revoked, ['AUTH-9'], 'the one whose number was lost is found by its request; another run\'s is left alone');
  assert.deepEqual(checks.map((check) => check.ok), [false, true]);
});

test('after a burst, every request of it that still waits is closed, also one whose submission reply was lost', async () => {
  const request = (requestId, username, purpose) => ({ request: { requestId, requester: { username }, recordId: 'REC-FIR-001', action: 'view', purpose } });
  const client = {
    get: async (route) => (route.startsWith('/access/auditor/pending/status')
      ? { status: 200, data: [{ requestId: route.split('=')[1], preparing: false }] }
      : { status: 200, data: [request('REQ-2', 'a', 'investigation'), request('REQ-LOST', 'b', 'prosecution'), request('REQ-OTHER', 'c', 'audit-review')] }),
  };
  const decided = [];
  const mac = { open: async () => ({}), decide: async (requestId) => { decided.push(requestId); return { decision: 'FORCE_DENY' }; } };
  const rows = [{ requestId: 'REQ-1', status: 'decided' }, { requestId: 'REQ-2', status: 'failed' },
    { username: 'b', recordId: 'REC-FIR-001', action: 'view', purpose: 'prosecution', status: 'failed' }];
  const closed = await closeLeftovers({ rows, client, watcher: null, auditor: 'sp.north', mac });
  assert.deepEqual(decided, ['REQ-2', 'REQ-LOST'], 'a request of another run is never decided');
  assert.equal(closed.find((entry) => entry.requestId === 'REQ-LOST').lostSubmission, true);
  assert.equal(rows[1].closedAfterBurst, true);
});

const { statusInChunks } = require('./setup-load');

test('the preparation status of many requests is asked in groups of at most 50', async () => {
  const asked = [];
  const client = { get: async (route) => {
    const ids = route.split('ids=')[1].split(',');
    asked.push(ids.length);
    return ids.length > 50 ? { status: 400, error: 'ids must be 1 to 50' } : { status: 200, data: ids.map((requestId) => ({ requestId, preparing: false })) };
  } };
  const ids = Array.from({ length: 120 }, (_, index) => `REQ-${index}`);
  const answers = await statusInChunks(client, 'sp.north', ids);
  assert.deepEqual(asked, [50, 50, 20]);
  assert.equal(answers.length, 120);
});
