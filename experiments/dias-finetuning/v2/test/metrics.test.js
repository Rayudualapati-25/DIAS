'use strict';

/**
 * Metrics must be right, because nothing downstream can detect that they are not.
 *
 * A wrong accuracy figure propagates into tables, reports and a paper, and looks
 * exactly like a right one. These tests fix each metric against hand-counted
 * cases, and pin the two decisions that are easy to get quietly wrong: an
 * unparseable answer is an ABSENT decision rather than a wrong one, and false
 * ALLOW is reported separately from false DENY rather than averaged away.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  confusion, errorCategories, groupBy, perClass, summarize, wilson,
} = require('../eval/metrics');

const label = (recommendation, reason_code = 'X', extra = {}) => ({
  recommendation, reason_code, reason: 'r',
  policy_refs: ['GP-DEFAULT:C1@v1'], missing_evidence: [], review_flags: [], ...extra,
});

const item = (expected, predicted, over = {}) => ({
  expected: label(expected),
  predicted: predicted === null ? null : label(predicted),
  status: predicted === null ? 'INVALID_OUTPUT' : 'OK',
  latencyMs: 100,
  ...over,
});

test('a perfect run scores 1 everywhere and reports no unsafe errors', () => {
  const m = summarize([item('ALLOW', 'ALLOW'), item('DENY', 'DENY')]);
  assert.equal(m.decisionAccuracy, 1);
  assert.equal(m.balancedAccuracy, 1);
  assert.equal(m.macroF1, 1);
  assert.equal(m.falseAllow.count, 0);
  assert.equal(m.falseDeny.count, 0);
  assert.equal(m.schemaValidRate, 1);
});

test('an always-DENY model scores 0.5 balanced accuracy, not the class prior', () => {
  // Eight DENY and two ALLOW: plain accuracy would flatter it at 0.8.
  const results = [
    ...Array.from({ length: 8 }, () => item('DENY', 'DENY')),
    ...Array.from({ length: 2 }, () => item('ALLOW', 'DENY')),
  ];
  const m = summarize(results);
  assert.equal(m.decisionAccuracy, 0.8);
  assert.equal(m.balancedAccuracy, 0.5, 'balanced accuracy must not reward the majority class');
  assert.equal(m.falseAllow.count, 0);
  assert.equal(m.falseDeny.count, 2);
});

test('an unparseable answer is an absent decision, never a safe DENY', () => {
  // If invalid counted as DENY, a model that fails on every DENY example would
  // look perfect on the safety metric.
  const results = [item('DENY', null), item('DENY', null), item('ALLOW', 'ALLOW')];
  const m = summarize(results);
  assert.equal(m.examples, 3);
  assert.equal(m.schemaValid, 1);
  assert.equal(m.invalid, 2);
  assert.equal(m.decisionAccuracy, 1, 'decision metrics cover only schema-valid answers');
  assert.equal(m.falseAllow.count, 0);
  assert.equal(m.confusionMatrix.DENY.DENY, 0, 'an invalid answer must not be credited as DENY');
  assert.equal(m.statusCounts.INVALID_OUTPUT, 2);
});

test('false ALLOW and false DENY are counted separately and not averaged', () => {
  const results = [
    item('DENY', 'ALLOW'), item('DENY', 'ALLOW'), item('DENY', 'DENY'),
    item('ALLOW', 'DENY'), item('ALLOW', 'ALLOW'),
  ];
  const m = summarize(results);
  assert.equal(m.falseAllow.count, 2);
  // Rates are rounded to six decimals so the JSON stays readable.
  assert.equal(m.falseAllow.ofDenyExamples, Number((2 / 3).toFixed(6)));
  assert.equal(m.falseDeny.count, 1);
  assert.equal(m.falseDeny.ofAllowExamples, 0.5);
  assert.notEqual(m.falseAllow.ofDenyExamples, m.falseDeny.ofAllowExamples);
});

test('the confusion matrix matches a hand count', () => {
  const c = confusion([
    item('ALLOW', 'ALLOW'), item('ALLOW', 'DENY'),
    item('DENY', 'ALLOW'), item('DENY', 'DENY'), item('DENY', 'DENY'),
    item('DENY', null),
  ]);
  assert.deepEqual(c, { ALLOW: { ALLOW: 1, DENY: 1 }, DENY: { ALLOW: 1, DENY: 2 } });
});

test('per-class precision, recall and F1 follow their definitions', () => {
  const c = { ALLOW: { ALLOW: 3, DENY: 1 }, DENY: { ALLOW: 2, DENY: 4 } };
  const allow = perClass(c, 'ALLOW');
  assert.equal(allow.truePositive, 3);
  assert.equal(allow.falsePositive, 2);
  assert.equal(allow.falseNegative, 1);
  assert.equal(allow.precision, 0.6);
  assert.equal(allow.recall, 0.75);
  assert.equal(allow.f1, Number(((2 * 0.6 * 0.75) / 1.35).toFixed(6)));
});

test('joint accuracy is stricter than decision accuracy alone', () => {
  const results = [{
    expected: label('DENY', 'NOT_ASSIGNED'),
    predicted: label('DENY', 'CROSS_JURISDICTION'),
    status: 'OK', latencyMs: 1,
  }];
  const m = summarize(results);
  assert.equal(m.decisionAccuracy, 1, 'the decision was right');
  assert.equal(m.reasonCodeAccuracy, 0, 'the reason was wrong');
  assert.equal(m.decisionAndReasonAccuracy, 0, 'the pair must fail');
  assert.equal(m.fullyCorrectRate, 0);
});

test('a fully correct response satisfies every joint metric', () => {
  const expected = label('DENY', 'NOT_ASSIGNED');
  const m = summarize([{ expected, predicted: { ...expected }, status: 'OK', latencyMs: 1 }]);
  assert.equal(m.reasonCodeAccuracy, 1);
  assert.equal(m.policyRefAccuracy, 1);
  assert.equal(m.reviewFlagAccuracy, 1);
  assert.equal(m.fullyCorrectRate, 1);
});

test('review-flag accuracy ignores ordering, because the flag set is unordered', () => {
  const expected = label('DENY', 'SEALED_RECORD', {
    review_flags: ['SEALED_RECORD_COURT_REVIEW', 'INSTRUCTION_IN_JUSTIFICATION'],
  });
  const predicted = label('DENY', 'SEALED_RECORD', {
    review_flags: ['INSTRUCTION_IN_JUSTIFICATION', 'SEALED_RECORD_COURT_REVIEW'],
  });
  const m = summarize([{ expected, predicted, status: 'OK', latencyMs: 1 }]);
  assert.equal(m.reviewFlagAccuracy, 1);
});

test('confidence intervals are reported and widen on small samples', () => {
  const wide = wilson(9, 10);
  const narrow = wilson(900, 1000);
  assert.ok(wide.high - wide.low > narrow.high - narrow.low,
    'a 10-example proportion must carry a wider interval than a 1000-example one');
  assert.ok(wide.low < 0.9 && wide.high > 0.9);
  assert.equal(wilson(0, 0), null);
});

test('latency percentiles are ordered and drawn from the observed values', () => {
  const results = Array.from({ length: 100 }, (_, i) => item('ALLOW', 'ALLOW', { latencyMs: i + 1 }));
  const m = summarize(results);
  assert.ok(m.latencyMs.median <= m.latencyMs.p95);
  assert.ok(m.latencyMs.p95 <= m.latencyMs.p99);
  assert.equal(m.latencyMs.max, 100);
  assert.equal(m.latencyMs.count, 100);
});

test('error categories separate unsafe errors from wrong explanations', () => {
  const categories = errorCategories([
    item('DENY', 'ALLOW'),
    item('ALLOW', 'DENY'),
    item('DENY', null),
    {
      expected: label('DENY', 'NOT_ASSIGNED'),
      predicted: label('DENY', 'CROSS_JURISDICTION'),
      status: 'OK', latencyMs: 1,
    },
  ]);
  assert.equal(categories['false-allow'], 1);
  assert.equal(categories['false-deny'], 1);
  assert.equal(categories['invalid:INVALID_OUTPUT'], 1);
  assert.equal(categories['right-decision-wrong-reason:NOT_ASSIGNED'], 1);
});

test('grouping computes each group independently', () => {
  const results = [
    { ...item('ALLOW', 'ALLOW'), role: 'inspector' },
    { ...item('DENY', 'ALLOW'), role: 'constable' },
  ];
  const groups = groupBy(results, (r) => r.role);
  assert.equal(groups.inspector.decisionAccuracy, 1);
  assert.equal(groups.constable.decisionAccuracy, 0);
  assert.equal(groups.constable.falseAllow.count, 1);
  assert.equal(groups.inspector.falseAllow.count, 0);
});

test('an empty run reports nulls rather than dividing by zero', () => {
  const m = summarize([]);
  assert.equal(m.examples, 0);
  assert.equal(m.decisionAccuracy, null);
  assert.equal(m.macroF1, null);
  assert.equal(m.latencyMs.median, null);
});
