'use strict';

// Run: node --test testbed/reuse/plan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { loadBundle } = require(path.join(REPO, 'policies/lib/bundle'));
const { FULL, SMOKE, buildPlan, baseCaseOf } = require('./plan');
const world = require('../seed/world');

const { bundle } = loadBundle(path.join(REPO, 'policies', 'dias-governance-policy-v1.json'));
const loadUsers = JSON.parse(fs.readFileSync(path.join(REPO, 'testbed/load/generated/users.json'), 'utf8'));
const full = buildPlan(FULL, loadUsers, bundle);

const withoutCase = (verified) => ({ ...verified, resource: { ...verified.resource, caseId: null } });

test('the plan is identical when built twice from the same seed', () => {
  assert.deepEqual(buildPlan(FULL, loadUsers, bundle), full);
});

test('100 users, one base request each, balanced by the written policy', () => {
  assert.equal(full.bases.length, 100);
  assert.equal(new Set(full.bases.map((b) => b.username)).size, 100);
  assert.equal(full.bases.filter((b) => b.expected === 'ALLOW').length, 50);
  assert.equal(full.bases.filter((b) => b.expected === 'DENY').length, 50);
});

test('300 records: every base request has its own record and two siblings', () => {
  assert.equal(full.streams.length, 300);
  assert.equal(new Set(full.streams.map((s) => s.recordId)).size, 300);
  for (const base of full.bases) {
    const kinds = full.streams.filter((s) => s.base === base.base).map((s) => s.kind).sort();
    assert.deepEqual(kinds, ['base', 'sibling', 'sibling']);
  }
});

test('no two users share the verified facts of their base request', () => {
  const baseHashes = full.streams.filter((s) => s.kind === 'base').map((s) => s.verifiedRequestHash);
  assert.equal(new Set(baseHashes).size, 100);
});

test('a sibling differs from its base only in record and case, and gets the same policy answer', () => {
  for (const sibling of full.streams.filter((s) => s.kind === 'sibling')) {
    const base = full.streams.find((s) => s.base === sibling.base && s.kind === 'base');
    assert.notEqual(sibling.recordId, base.recordId);
    assert.notEqual(sibling.caseId, base.caseId);
    assert.equal(baseCaseOf(sibling.caseId), base.caseId);
    assert.deepEqual(withoutCase(sibling.verifiedRequest), withoutCase(base.verifiedRequest));
    assert.equal(sibling.expected, base.expected);
    assert.equal(sibling.expectedReasonCode, base.expectedReasonCode);
    const { recordId: _a, caseId: _b, ...siblingProperties } = sibling.record;
    const { recordId: _c, caseId: _d, ...baseProperties } = base.record;
    assert.deepEqual(siblingProperties, baseProperties);
  }
});

test('the base record copy keeps the facts of the world record it copies', () => {
  for (const base of full.streams.filter((s) => s.kind === 'base')) {
    const source = world.RECORDS.find((r) => r.recordId === base.worldRecordId);
    assert.equal(base.caseId, source.caseId);
    assert.equal(base.record.recordType, source.recordType);
    assert.equal(base.record.sensitivityLevel, source.sensitivityLevel);
  }
});

test('approvals are drawn once per base request and do not depend on the number of rounds', () => {
  const fewerRounds = buildPlan({ ...FULL, rounds: 3 }, loadUsers, bundle);
  assert.deepEqual(fewerRounds.bases, full.bases);
  const approved = full.bases.filter((b) => b.approveIfModelDenies).length;
  assert.ok(approved > 30 && approved < 70, `approved ${approved} of 100 with p = 0.5`);
});

test('every round sends each user\'s three requests once, in some order', () => {
  assert.equal(full.rounds.length, 8);
  for (const round of full.rounds) {
    assert.equal(Object.keys(round.order).length, 100);
    for (const [username, order] of Object.entries(round.order)) {
      const own = full.streams.filter((s) => s.username === username).map((s) => s.streamId).sort();
      assert.deepEqual([...order].sort(), own);
    }
  }
});

test('sibling cases copy the world case, including every assigned load user', () => {
  for (const sibling of full.siblingCases) {
    const source = world.CASES.find((c) => c.caseId === sibling.copyOf);
    assert.equal(sibling.body.jurisdiction, source.jurisdiction);
    assert.deepEqual(sibling.body.protectedClassifications, source.protectedClassifications);
    const clones = loadUsers.filter((u) => source.assignedProfiles.includes(u.profile)).map((u) => u.username);
    for (const username of [...source.assignedProfiles, ...clones]) assert.ok(sibling.body.assignedUsers.includes(username));
  }
});

test('the smoke plan is small, uses its own record names and approves every denied base', () => {
  const smoke = buildPlan(SMOKE, loadUsers, bundle);
  assert.equal(smoke.bases.length, 4);
  assert.equal(smoke.streams.length, 12);
  assert.ok(smoke.streams.every((s) => s.recordId.startsWith('RUSMK')));
  assert.ok(smoke.bases.every((b) => b.approveIfModelDenies));
  assert.ok(full.streams.every((s) => !s.recordId.startsWith('RUSMK')));
});
