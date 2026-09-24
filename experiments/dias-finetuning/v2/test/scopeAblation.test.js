'use strict';

/**
 * The scope ablation must be a fair comparison.
 *
 * Both arms have to see the same requests, the same model labels and the same
 * auditor behaviour, or the difference between them is not attributable to the
 * scope design. These tests pin that, and pin the property the whole design
 * decision rests on: an exact-record authorization can never reach a second
 * record, and a property fingerprint can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRng } = require('../lib/rng');
const {
  buildStream, exactScope, propertyScope, replay,
} = require('../eval/scope-ablation');

const example = (over = {}) => ({
  exampleId: over.exampleId || 'EX-1',
  username: 'u-abc',
  recordId: over.recordId || 'REC-1',
  caseId: over.caseId || 'CASE-1',
  label: { recommendation: over.recommendation || 'DENY' },
  verifiedRequest: {
    requester: {
      mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3',
      station: 'PS-1', jurisdiction: 'north', clearance: 'high',
      credentialStatus: 'active', assignedToRequestedCase: false,
    },
    resource: {
      recordType: 'fir', caseId: over.caseId || 'CASE-1', sensitivityLevel: 'medium',
      jurisdiction: 'north', owningAgency: 'police', owningStation: 'PS-1',
      sealed: false, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
    },
    request: {
      action: 'view', purpose: 'investigation', emergencyFlag: false, approvalTokenPresent: false,
    },
  },
});

const asRequest = (e) => ({
  exampleId: e.exampleId,
  stableUserId: `MSP::${e.username}`,
  recordId: e.recordId,
  caseId: e.caseId,
  action: e.verifiedRequest.request.action,
  purpose: e.verifiedRequest.request.purpose,
  verifiedRequest: e.verifiedRequest,
  label: e.label,
});

test('exact-record scope distinguishes two records with identical properties', () => {
  const a = asRequest(example({ recordId: 'REC-1', caseId: 'CASE-1' }));
  const b = asRequest(example({ exampleId: 'EX-2', recordId: 'REC-2', caseId: 'CASE-2' }));
  assert.notEqual(exactScope(a), exactScope(b));
});

test('the property fingerprint does NOT — which is the defect being measured', () => {
  const a = asRequest(example({ recordId: 'REC-1', caseId: 'CASE-1' }));
  const b = asRequest(example({ exampleId: 'EX-2', recordId: 'REC-2', caseId: 'CASE-2' }));
  assert.equal(propertyScope(a), propertyScope(b),
    'the SEAL fingerprint excluded recordId and caseId, so these collide');
});

test('both scopes still distinguish a different action or purpose', () => {
  const a = asRequest(example());
  const other = example();
  other.verifiedRequest.request = { ...other.verifiedRequest.request, action: 'export' };
  const b = asRequest(other);
  b.action = 'export';
  assert.notEqual(exactScope(a), exactScope(b));
  assert.notEqual(propertyScope(a), propertyScope(b));
});

test('an exact-record approval never reaches a second record', () => {
  const stream = [
    asRequest(example({ exampleId: 'EX-1', recordId: 'REC-1', caseId: 'CASE-1' })),
    asRequest(example({ exampleId: 'EX-2', recordId: 'REC-2', caseId: 'CASE-2' })),
    asRequest(example({ exampleId: 'EX-1#r1', recordId: 'REC-1', caseId: 'CASE-1' })),
  ];
  const arm = replay(stream, exactScope, () => true);
  assert.equal(arm.automaticGrantsOnADifferentRecord, 0);
  assert.equal(arm.recordsPerApproval.max, 1);
});

test('a property-fingerprint approval does reach a second record', () => {
  const stream = [
    asRequest(example({ exampleId: 'EX-1', recordId: 'REC-1', caseId: 'CASE-1' })),
    asRequest(example({ exampleId: 'EX-2', recordId: 'REC-2', caseId: 'CASE-2' })),
  ];
  const arm = replay(stream, propertyScope, () => true);
  assert.equal(arm.automaticGrantsOnADifferentRecord, 1,
    'the second record was auto-granted on an approval it never appeared in');
  assert.equal(arm.recordsPerApproval.max, 2);
});

test('only a model DENY the auditor overrides creates an authorization', () => {
  const allowStream = [
    asRequest(example({ recommendation: 'ALLOW' })),
    asRequest(example({ exampleId: 'EX-1#r1', recommendation: 'ALLOW' })),
  ];
  const arm = replay(allowStream, exactScope, () => true);
  assert.equal(arm.authorizationsCreated, 0, 'an ALLOW must never create one');
  assert.equal(arm.automaticGrants, 0);

  const denyNotOverridden = replay([asRequest(example()), asRequest(example({ exampleId: 'EX-1#r1' }))],
    exactScope, () => false);
  assert.equal(denyNotOverridden.authorizationsCreated, 0, 'FORCE_DENY must never create one');
});

test('every request is accounted for: skipped or reviewed, never both, never neither', () => {
  const rng = createRng(1, 'test');
  const cases = Array.from({ length: 6 }, (_, i) =>
    example({ exampleId: `EX-${i}`, recordId: `REC-${i}`, caseId: `CASE-${i}` }));
  const stream = buildStream(rng, cases, 2, 1);
  for (const scope of [exactScope, propertyScope]) {
    const arm = replay(stream, scope, () => true);
    assert.equal(arm.modelInvocations + arm.automaticGrants, arm.requests);
    assert.equal(arm.modelInvocations, arm.auditorReviews,
      'a request that reaches the model always reaches the auditor too');
    assert.equal(
      arm.automaticGrantsOnTheApprovedRecord + arm.automaticGrantsOnADifferentRecord,
      arm.automaticGrants);
  }
});

test('with no siblings the two designs are identical, and the report must say so', () => {
  const rng = createRng(2, 'test');
  // Each case must differ in a GOVERNED property, otherwise they are siblings of
  // one another and "siblings: 0" would not mean what the test claims.
  const types = ['fir', 'case-diary', 'evidence', 'forensic-report',
    'witness-statement', 'chargesheet', 'court-order', 'fir'];
  const cases = types.map((recordType, i) => {
    const e = example({ exampleId: `EX-${i}`, recordId: `REC-${i}`, caseId: `CASE-${i}` });
    e.verifiedRequest.resource = {
      ...e.verifiedRequest.resource, recordType, owningStation: `PS-${i}`,
    };
    return e;
  });
  const stream = buildStream(rng, cases, 2, 0);
  const exact = replay(stream, exactScope, () => true);
  const property = replay(stream, propertyScope, () => true);
  assert.deepEqual(
    { g: exact.automaticGrants, d: exact.automaticGrantsOnADifferentRecord },
    { g: property.automaticGrants, d: property.automaticGrantsOnADifferentRecord },
    'without records sharing properties the scope choice changes nothing');
});

test('both arms replay the identical stream, so the difference is the scope alone', () => {
  const rng = createRng(3, 'test');
  const cases = Array.from({ length: 5 }, (_, i) =>
    example({ exampleId: `EX-${i}`, recordId: `REC-${i}`, caseId: `CASE-${i}` }));
  const stream = buildStream(rng, cases, 1, 2);
  const exact = replay(stream, exactScope, () => true);
  const property = replay(stream, propertyScope, () => true);
  assert.equal(exact.requests, property.requests);
  assert.ok(property.modelInvocations <= exact.modelInvocations,
    'a coarser scope can only ever do less work, never more');
});

test('the stream is deterministic from its seed', () => {
  const cases = Array.from({ length: 4 }, (_, i) => example({ exampleId: `EX-${i}`, recordId: `REC-${i}` }));
  const a = buildStream(createRng(9, 'x'), cases, 2, 1).map((r) => r.exampleId);
  const b = buildStream(createRng(9, 'x'), cases, 2, 1).map((r) => r.exampleId);
  assert.deepEqual(a, b);
});
