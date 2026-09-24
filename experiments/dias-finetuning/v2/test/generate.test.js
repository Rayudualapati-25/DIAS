'use strict';

/**
 * Generator properties.
 *
 * Reproducibility is the one property an experiment record cannot assert its way
 * into: either the same seed produces the same bytes, or the recorded seed is
 * decoration. The rest of these tests pin invariants a future change could break
 * quietly — a scenario constructor that stops producing the clause it claims, or
 * a split assignment that drifts when families are added.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundle } = require('../../../../policies/lib/bundle');
const {
  evaluateReference,
} = require('../../../../policies/reference-oracle/referencePolicyOracle');
const { createRng } = require('../lib/rng');
const { createIdentifierFactory } = require('../lib/identifiers');
const { roleIndex, DISTRICTS } = require('../lib/world');
const scenarios = require('../lib/scenarios');
const { flagsForFamily, ALL_FAMILIES, HELD_OUT_FAMILIES, TRAINABLE_FAMILIES } = require('../lib/justifications');
const { labelFor } = require('../lib/example');
const { splitForFamily } = require('../lib/families');
const { SPLIT_WEIGHTS } = require('../lib/plan');
const generate = require('../generate');
const crypto = require('crypto');

const { bundle } = loadBundle();
const index = roleIndex(bundle);
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

test('the same seed produces byte-identical examples', () => {
  const first = generate.generateCleanAllow(generate.createContext(4242));
  const second = generate.generateCleanAllow(generate.createContext(4242));
  assert.equal(first.length, second.length);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('a different seed produces a different dataset', () => {
  const a = generate.generateCleanAllow(generate.createContext(1));
  const b = generate.generateCleanAllow(generate.createContext(2));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('independent rng streams do not disturb each other', () => {
  const base = createRng(9);
  const before = base.stream('b').int(0, 1e9);
  const other = createRng(9);
  other.stream('a').int(0, 1e9);
  other.stream('a').int(0, 1e9);
  assert.equal(other.stream('b').int(0, 1e9), before);
});

test('identifiers carry no ordering a reader could exploit', () => {
  const factory = createIdentifierFactory(11);
  const ids = Array.from({ length: 200 }, () => factory.recordId().slice(4));
  const sorted = [...ids].sort();
  assert.notEqual(ids.join(), sorted.join(), 'consecutive identifiers must not be ordered');
});

test('clean-allow scenarios really are ALLOW under the oracle', () => {
  const rng = createRng(5, 'clean');
  for (let i = 0; i < 300; i += 1) {
    const facts = scenarios.cleanAllow(rng, bundle, index);
    facts.resource.caseId = 'CASE-TEST';
    assert.equal(evaluateReference(bundle, facts).recommendation, 'ALLOW',
      `clean scenario denied: ${JSON.stringify(facts)}`);
  }
});

test('each single-violation constructor produces its own clause and no other reason', () => {
  const rng = createRng(6, 'single');
  for (const clause of scenarios.SINGLE_VIOLATION_CLAUSES) {
    let produced = 0;
    for (let i = 0; i < 120 && produced < 20; i += 1) {
      const facts = scenarios.singleViolation(rng, bundle, clause, index);
      if (!facts) continue;
      facts.resource.caseId = 'CASE-TEST';
      const verdict = evaluateReference(bundle, facts);
      assert.equal(verdict.recommendation, 'DENY', `${clause} did not deny`);
      assert.ok(verdict.applicable_deny_clauses.includes(`${clause}@v1`),
        `${clause} not among ${verdict.applicable_deny_clauses.join(',')}`);
      produced += 1;
    }
    assert.ok(produced > 0, `${clause} produced nothing in 120 attempts`);
  }
});

test('near-miss pairs differ in label but share almost everything else', () => {
  const rng = createRng(8, 'near');
  for (const kind of scenarios.NEAR_MISS_KINDS) {
    let checked = 0;
    for (let i = 0; i < 80 && checked < 10; i += 1) {
      const pair = scenarios.nearMiss(rng, bundle, kind, index);
      if (!pair.allow || !pair.deny) continue;
      pair.allow.resource.caseId = 'CASE-A';
      pair.deny.resource.caseId = 'CASE-A';
      const a = evaluateReference(bundle, pair.allow).recommendation;
      const d = evaluateReference(bundle, pair.deny).recommendation;
      assert.equal(a, 'ALLOW', `${kind}: allow half denied`);
      assert.equal(d, 'DENY', `${kind}: deny half allowed`);
      checked += 1;
    }
    assert.ok(checked > 0, `${kind} produced no usable pair`);
  }
});

test('multi-violation scenarios really apply every clause they name', () => {
  const rng = createRng(12, 'multi');
  let produced = 0;
  for (let i = 0; i < 300 && produced < 60; i += 1) {
    const clauses = rng.sample(scenarios.SINGLE_VIOLATION_CLAUSES, 2);
    const facts = scenarios.multiViolation(rng, bundle, clauses, index);
    if (!facts) continue;
    facts.resource.caseId = 'CASE-TEST';
    const verdict = evaluateReference(bundle, facts);
    assert.equal(verdict.recommendation, 'DENY');
    assert.ok(verdict.applicable_deny_clauses.length >= 2,
      `expected several clauses, got ${verdict.applicable_deny_clauses.join(',')}`);
    produced += 1;
  }
  assert.ok(produced >= 20, `only ${produced} multi-clause scenarios in 300 attempts`);
});

test('cross-jurisdiction uses two real districts, never a derived string', () => {
  const rng = createRng(13, 'juris');
  for (let i = 0; i < 60; i += 1) {
    const facts = scenarios.singleViolation(rng, bundle, 'GP-JURIS:C1', index);
    if (!facts) continue;
    assert.ok(DISTRICTS.includes(facts.requester.jurisdiction));
    assert.ok(DISTRICTS.includes(facts.resource.jurisdiction));
    assert.notEqual(facts.requester.jurisdiction, facts.resource.jurisdiction);
    assert.ok(!facts.resource.jurisdiction.includes('outside'),
      'v1 encoded the answer in the field; the value must be an ordinary district');
  }
});

test('review flags come from the justification family declaration', () => {
  const rng = createRng(14, 'flags');
  const facts = scenarios.cleanAllow(rng, bundle, index);
  facts.resource.caseId = 'CASE-TEST';
  assert.deepEqual(labelFor(bundle, facts, 'plain-operational').review_flags, []);
  assert.deepEqual(labelFor(bundle, facts, 'inject-override').review_flags,
    ['INSTRUCTION_IN_JUSTIFICATION']);
  assert.deepEqual(labelFor(bundle, facts, 'claim-role').review_flags,
    ['UNVERIFIED_CLAIM_IN_JUSTIFICATION']);
  assert.deepEqual(labelFor(bundle, facts, 'inject-both').review_flags,
    ['INSTRUCTION_IN_JUSTIFICATION', 'UNVERIFIED_CLAIM_IN_JUSTIFICATION']);
});

test('a sealed record adds the court-review flag on top of the text flags', () => {
  const rng = createRng(15, 'seal');
  let facts = null;
  for (let i = 0; i < 200 && !facts; i += 1) {
    facts = scenarios.singleViolation(rng, bundle, 'GP-SEAL:C1', index);
  }
  facts.resource.caseId = 'CASE-TEST';
  assert.deepEqual(labelFor(bundle, facts, 'plain-operational').review_flags,
    ['SEALED_RECORD_COURT_REVIEW']);
  assert.deepEqual(labelFor(bundle, facts, 'inject-override').review_flags,
    ['INSTRUCTION_IN_JUSTIFICATION', 'SEALED_RECORD_COURT_REVIEW']);
});

test('every justification family declares flags and renders every template', () => {
  const surface = {
    action: 'view', purpose: 'investigation', recordType: 'fir', caseId: 'CASE-1',
    recordId: 'REC-1', claimedRole: 'judge', claimedClearance: 'high',
  };
  for (const family of ALL_FAMILIES) {
    assert.ok(Array.isArray(flagsForFamily(family.id)));
    for (let i = 0; i < family.templates.length; i += 1) {
      const text = family.templates[i](surface);
      assert.ok(typeof text === 'string' && text.length > 10,
        `${family.id}[${i}] rendered nothing usable`);
    }
  }
});

test('held-out template families are disjoint from trainable ones', () => {
  const trainable = new Set(TRAINABLE_FAMILIES.map((f) => f.id));
  for (const family of HELD_OUT_FAMILIES) {
    assert.ok(!trainable.has(family.id), `${family.id} is both trainable and held out`);
  }
});

test('split assignment is stable when families are added', () => {
  const hash = (text) => sha256(`99::${text}`);
  const before = ['FAM-a', 'FAM-b', 'FAM-c'].map((id) => splitForFamily(id, hash, SPLIT_WEIGHTS));
  const after = ['FAM-a', 'FAM-new', 'FAM-b', 'FAM-c']
    .filter((id) => id !== 'FAM-new')
    .map((id) => splitForFamily(id, hash, SPLIT_WEIGHTS));
  assert.deepEqual(before, after);
});

test('split assignment respects the declared weights in aggregate', () => {
  const hash = (text) => sha256(`77::${text}`);
  const counts = { train: 0, validation: 0, test: 0 };
  for (let i = 0; i < 6000; i += 1) counts[splitForFamily(`FAM-${i}`, hash, SPLIT_WEIGHTS)] += 1;
  for (const [split, weight] of Object.entries(SPLIT_WEIGHTS)) {
    assert.ok(Math.abs(counts[split] / 6000 - weight) < 0.02,
      `${split} share ${(counts[split] / 6000).toFixed(3)} is far from ${weight}`);
  }
});

test('no example ever carries an ESCALATE label or an evidence requirement', () => {
  const context = generate.createContext(31);
  for (const example of generate.generateSingleViolations(context).slice(0, 400)) {
    assert.ok(['ALLOW', 'DENY'].includes(example.meta.label.recommendation));
    assert.deepEqual(example.meta.label.missing_evidence, []);
  }
});

test('INVALID_PURPOSE never appears, because the runtime cannot produce it', () => {
  const context = generate.createContext(32);
  const examples = [
    ...generate.generateSingleViolations(context),
    ...generate.generateMultiViolations(context),
  ];
  const offending = examples.filter((e) => e.meta.label.reason_code === 'INVALID_PURPOSE');
  assert.deepEqual(offending, []);
  for (const example of examples) {
    assert.ok(bundle.vocabularies.purposes.includes(example.meta.verifiedRequest.request.purpose));
  }
});
