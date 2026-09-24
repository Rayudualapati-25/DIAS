'use strict';

/**
 * The checks must be able to fail.
 *
 * A validator that passes on a clean dataset proves nothing on its own — it may
 * simply be incapable of returning false. Every test here injects the exact
 * defect the check exists to catch, including the ones data-v1 actually had, and
 * asserts the check reports it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBundle } = require('../../../../policies/lib/bundle');
const checks = require('../lib/checks');
const { readCases } = require('../validate');
const { HELD_OUT_FAMILIES } = require('../lib/justifications');
const path = require('path');

const DIR = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const { bundle, clauseRefs } = loadBundle();
const policy = {
  clauseRefs, reasonCodes: bundle.reasonCodes, reviewFlags: Object.keys(bundle.reviewFlags),
};

const train = readCases(DIR, 'train');
const testDecision = readCases(DIR, 'test-decision-balanced');
const validation = readCases(DIR, 'validation-balanced');
const ood = readCases(DIR, 'test-ood-paraphrase');
const bySet = {
  train,
  'validation-balanced': validation,
  'test-decision-balanced': testDecision,
  'test-ood-paraphrase': ood,
};
const all = [...train, ...testDecision, ...validation, ...ood];

/** A deep copy, so a mutation in one test cannot reach another. */
const clone = (value) => JSON.parse(JSON.stringify(value));

test('schema check rejects a third recommendation class', () => {
  const corrupted = clone(all.slice(0, 50));
  corrupted[3].label.recommendation = 'ESCALATE';
  assert.equal(checks.checkSchema(corrupted, policy).ok, false);
  assert.equal(checks.checkSchema(clone(all.slice(0, 50)), policy).ok, true);
});

test('schema check rejects a reason code that contradicts the recommendation', () => {
  const corrupted = clone(all.slice(0, 50));
  corrupted[5].label.recommendation = 'ALLOW';
  corrupted[5].label.reason_code = 'NOT_ASSIGNED';
  assert.equal(checks.checkSchema(corrupted, policy).ok, false);
});

test('label reproduction detects a flipped label', () => {
  const corrupted = clone(all.slice(0, 200));
  const target = corrupted.find((e) => e.label.recommendation === 'ALLOW');
  target.label.recommendation = 'DENY';
  assert.equal(checks.checkLabelReproduction(corrupted, bundle).ok, false);
});

test('label reproduction detects a review flag added without justification for it', () => {
  const corrupted = clone(all.slice(0, 200));
  const target = corrupted.find((e) => e.label.review_flags.length === 0);
  target.label.review_flags = ['INSTRUCTION_IN_JUSTIFICATION'];
  assert.equal(checks.checkLabelReproduction(corrupted, bundle).ok, false);
});

test('balance check detects a skewed set', () => {
  const skewed = {
    train: clone(train).map((e) => ({ ...e, label: { ...e.label, recommendation: 'ALLOW' } })),
  };
  assert.equal(checks.checkBalance(skewed, 0.02, ['train']).ok, false);
  assert.equal(checks.checkBalance(bySet, 0.02, ['train']).ok, true);
});

test('duplicate check detects a prompt repeated inside one set', () => {
  const corrupted = { train: [...clone(train.slice(0, 50)), clone(train[0])] };
  assert.equal(checks.checkDuplicatePrompts(corrupted).ok, false);
});

test('duplicate check detects a training prompt reappearing in test', () => {
  const leaked = clone(train[0]);
  const corrupted = {
    train: clone(train.slice(0, 50)),
    'test-decision-balanced': [...clone(testDecision.slice(0, 50)), leaked],
  };
  assert.equal(checks.checkDuplicatePrompts(corrupted).ok, false);
});

test('duplicate check tolerates the same example in two views of the test split', () => {
  const shared = clone(testDecision[0]);
  const corrupted = {
    'test-decision-balanced': clone(testDecision.slice(0, 20)),
    'test-multi-rule': [shared],
  };
  assert.equal(checks.checkDuplicatePrompts(corrupted).ok, true);
});

test('feature leakage detects the same facts phrased differently across splits', () => {
  const leaked = clone(train[0]);
  leaked.exampleId = 'EX-leak';
  leaked.promptHash = 'different-prompt-hash';
  leaked.justification = 'a completely different sentence with the same facts';
  const corrupted = {
    train: clone(train.slice(0, 100)),
    'test-decision-balanced': [...clone(testDecision.slice(0, 100)), leaked],
  };
  assert.equal(checks.checkFeatureLeakage(corrupted).ok, false);
});

test('family leakage detects a near-miss pair split across train and test', () => {
  const half = clone(train[0]);
  half.exampleId = 'EX-half';
  half.promptHash = 'other';
  const corrupted = {
    train: clone(train.slice(0, 100)),
    'test-decision-balanced': [...clone(testDecision.slice(0, 100)), half],
  };
  assert.equal(checks.checkFamilyLeakage(corrupted).ok, false);
});

test('template leakage detects held-out phrasing used in training', () => {
  const held = HELD_OUT_FAMILIES.map((f) => f.id);
  const corrupted = clone(bySet);
  corrupted.train = [...clone(train.slice(0, 50))];
  corrupted.train[0].justificationFamily = held[0];
  assert.equal(checks.checkTemplateLeakage(corrupted, held).ok, false);
});

test('template leakage detects an OOD set contaminated with trained phrasing', () => {
  const held = HELD_OUT_FAMILIES.map((f) => f.id);
  const corrupted = clone(bySet);
  corrupted['test-ood-paraphrase'] = clone(ood.slice(0, 20));
  corrupted['test-ood-paraphrase'][0].justificationFamily = 'plain-operational';
  assert.equal(checks.checkTemplateLeakage(corrupted, held).ok, false);
});

test('identifier check detects v1-style usernames containing the role and split', () => {
  const corrupted = clone(all.slice(0, 50));
  corrupted[0].username = `insp.${corrupted[0].verifiedRequest.requester.role}.train.001`;
  assert.equal(checks.checkIdentifierLeakage(corrupted).ok, false);
});

test('identifier check detects a record id that spells out the reason code', () => {
  const corrupted = clone(all.slice(0, 50));
  const target = corrupted.find((e) => e.label.reason_code === 'POLICY_SATISFIED') || corrupted[0];
  target.recordId = `REC-${target.label.reason_code}-001`;
  assert.equal(checks.checkIdentifierLeakage(corrupted).ok, false);
});

test('predictiveness check detects v1-style per-reason identifier ranges', () => {
  // v1 gave each reason code its own contiguous range, so a prefix bucket was
  // pure. This is the exact defect, reproduced.
  const corrupted = clone(all);
  let allowIndex = 0;
  let denyIndex = 0;
  for (const example of corrupted) {
    example.recordId = example.label.recommendation === 'ALLOW'
      ? `REC-AA${String(allowIndex += 1).padStart(8, '0')}`
      : `REC-BB${String(denyIndex += 1).padStart(8, '0')}`;
  }
  const result = checks.checkIdentifierPredictiveness(corrupted, 'recordId', 6, { minBucket: 50, sigma: 4 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /REC-AA|REC-BB/);
});

test('predictiveness check does not flag ordinary sampling noise', () => {
  assert.equal(
    checks.checkIdentifierPredictiveness(all, 'recordId', 6, { minBucket: 50, sigma: 4 }).ok,
    true);
  assert.equal(
    checks.checkIdentifierPredictiveness(all, 'username', 4, { minBucket: 50, sigma: 4 }).ok,
    true);
});

test('coverage check detects a missing reason code', () => {
  const withoutSealed = clone(all).filter((e) => e.label.reason_code !== 'SEALED_RECORD');
  assert.equal(checks.checkCoverage(withoutSealed, bundle).ok, false);
  assert.equal(checks.checkCoverage(clone(all), bundle).ok, true);
});

test('vocabulary coverage detects a clearance level that never appears', () => {
  // v1 used only high and low, so the ordered comparison was never exercised.
  const withoutMedium = clone(all).filter(
    (e) => e.verifiedRequest.requester.clearance !== 'medium');
  assert.equal(checks.checkVocabularyCoverage(withoutMedium, bundle).ok, false);
});

test('precedence check detects references listed out of order', () => {
  const corrupted = clone(all);
  const target = corrupted.find((e) => e.label.policy_refs.length > 1 && e.label.recommendation === 'DENY');
  target.label.policy_refs = [...target.label.policy_refs].reverse();
  assert.equal(checks.checkPrecedence(corrupted, bundle).ok, false);
});

test('precedence check detects a dataset with no multi-clause example at all', () => {
  // v1 had exactly zero, so precedence was completely untested.
  const singleOnly = clone(all).filter((e) => e.label.policy_refs.length <= 1
    || e.label.recommendation === 'ALLOW');
  assert.equal(checks.checkPrecedence(singleOnly, bundle).ok, false);
});

test('explanation grounding detects a reason citing a clause the label omits', () => {
  const corrupted = clone(all.slice(0, 50));
  corrupted[0].label.reason = `${corrupted[0].label.reason} Also GP-JUV:C1@v1 applies.`;
  assert.equal(checks.checkExplanationGrounding(corrupted).ok, false);
});

test('independence check detects a field that never varies', () => {
  // v1 set emergencyFlag false in every example.
  const corrupted = clone(all.slice(0, 300)).map((e) => ({
    ...e,
    verifiedRequest: {
      ...e.verifiedRequest,
      request: { ...e.verifiedRequest.request, emergencyFlag: false },
    },
  }));
  const result = checks.checkIrrelevantFieldIndependence(corrupted, 0.08);
  assert.equal(result.ok, false);
  assert.match(result.detail, /emergencyFlag takes only one value/);
});

test('independence check detects a distractor that predicts the label', () => {
  const corrupted = clone(all.slice(0, 600)).map((e) => ({
    ...e,
    verifiedRequest: {
      ...e.verifiedRequest,
      request: {
        ...e.verifiedRequest.request,
        emergencyFlag: e.label.recommendation === 'ALLOW',
      },
    },
  }));
  assert.equal(checks.checkIrrelevantFieldIndependence(corrupted, 0.08).ok, false);
});

test('scenario presence detects training with no adversarial text', () => {
  const withoutAttacks = {
    train: clone(train).filter((e) => !['injection', 'contradictory'].includes(e.justificationKind)),
  };
  assert.equal(checks.checkScenarioPresence(withoutAttacks).ok, false);
  assert.equal(checks.checkScenarioPresence(bySet).ok, true);
});
