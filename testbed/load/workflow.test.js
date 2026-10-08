'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatcher, auditorFor, runWorkflow } = require('./workflow');
const { verifiedFor } = require('./plan');
const world = require('../seed/world');
const { verifiedRequestHash } = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');

test('all requesting departments route to the independent Audit district head', () => {
  for (const org of ['police', 'forensics', 'prosecution', 'court']) {
    assert.equal(auditorFor({ recordId: 'REC-FIR-001' }, { org }), 'sp.north');
    assert.equal(auditorFor({ recordId: 'REC-SOUTH-FIR-001' }, { org }), 'sp.south');
  }
});

test('watcher polls status in groups of at most 50 without opening reviews or files', async () => {
  const calls = [];
  let round = 0;
  const client = { async preparationStatus(ids, auditor) {
    calls.push({ ids, auditor });
    return { status: 200, data: ids.map(requestId => ({ requestId, preparing: round++ < 2 })) };
  }};
  const watcher = createWatcher(client, 2);
  const results = await Promise.all(Array.from({ length: 55 }, (_, i) => watcher.wait(`REQ-${i}`, 1000, 'sp.south')));
  assert.equal(results.length, 55);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every(c => c.ids.length <= 50 && c.auditor === 'sp.south'));
  assert.ok(results.every(r => typeof r.observedAt === 'number'));
});

test('watcher exposes API failures instead of pretending readiness', async () => {
  const watcher = createWatcher({ preparationStatus: async () => ({ status: 403, error: 'forbidden' }) }, 2);
  await assert.rejects(watcher.wait('REQ-1', 1000), /403.*forbidden/);
});

test('a recommendation still being signed times out', async () => {
  const watcher = createWatcher({ preparationStatus: async ids => ({
    status: 200, data: ids.map(requestId => ({ requestId, preparing: true })),
  }) }, 2);
  await assert.rejects(watcher.wait('REQ-1', 10), /not ready/);
});

test('a status response arriving after the deadline cannot report readiness', async () => {
  const watcher = createWatcher({ preparationStatus: async ids => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return { status: 200, data: ids.map(requestId => ({ requestId, preparing: false })) };
  } }, 1);
  await assert.rejects(watcher.wait('REQ-slow', 10), /not ready/);
});

function workflowFixture(integrityStatus) {
  const user = world.REQUESTERS.find(item => item.username === 'insp.sharma');
  const record = world.RECORDS.find(item => item.recordId === 'REC-FIR-001');
  const verified = verifiedFor(user, record, 'view', 'investigation');
  const calls = [];
  const client = {
    submit: async () => ({ status: 202, data: { requestId: 'REQ-unit' } }),
    review: async () => ({ status: 200, ms: 1, data: {
      request: { verifiedRequest: verified, verifiedRequestHash: verifiedRequestHash(verified) },
      recommendationState: 'committed', commitment: {}, integrity: { status: integrityStatus },
      recommendation: { generationStatus: 'OK', recommendation: 'ALLOW' } } }),
    decide: async (_id, auditor, body) => {
      calls.push({ auditor, body });
      return { status: 201, ms: 1, data: { auditorDecision: { llmRecommendation: 'ALLOW', llmAgreement: 'AGREED' } } };
    },
  };
  return { calls, options: { client, user, timeoutMs: 1000,
    watcher: { wait: async () => ({ observedAt: Date.now() }) },
    request: { username: user.username, recordId: record.recordId, action: 'view', purpose: 'investigation',
      justification: 'unit fixture', verifiedRequestHash: verifiedRequestHash(verified) } } };
}

test('a verified committed recommendation drives the auditor decision', async () => {
  const fixture = workflowFixture('verified');
  const row = await runWorkflow(fixture.options);
  assert.equal(row.status, 'completed');
  assert.equal(row.validRecommendation, true);
  assert.deepEqual(fixture.calls, [{ auditor: 'sp.north', body: { decision: 'FORCE_ALLOW' } }]);
});

test('a tampered committed recommendation never drives a decision', async () => {
  const fixture = workflowFixture('mismatch');
  const row = await runWorkflow(fixture.options);
  assert.equal(row.status, 'failed');
  assert.equal(row.stage, 'review');
  assert.match(row.error, /integrity/);
  assert.deepEqual(fixture.calls, []);
});
