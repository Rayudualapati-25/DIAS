'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractJson, schemaProblems, summarise } = require('./evaluate');

const classification = {
  action: 'view', purpose: 'investigation', decision: 'allow',
  reasonCode: 'POLICY_SATISFIED', policyVersion: 'crime-policy-v1',
  modelVersion: 'qwen3-14b-seba-lora-v4',
};

test('strict JSON excludes outputs wrapped in hidden reasoning', () => {
  assert.equal(extractJson(JSON.stringify(classification)).strict, true);
  const wrapped = extractJson(`<think>private trace</think>${JSON.stringify(classification)}`);
  assert.equal(wrapped.strict, false);
  assert.deepEqual(wrapped.value, classification);
});

test('schema validation retains decision/reason disagreement as a quality signal', () => {
  assert.deepEqual(schemaProblems(classification), []);
  assert.deepEqual(schemaProblems({ ...classification, decision: 'deny' }), []);
});

test('summary reports macro-F1 and counts false allows', () => {
  const rows = [
    {
      expected: { decision: 'allow', reasonCode: 'POLICY_SATISFIED' },
      prediction: { decision: 'allow', reasonCode: 'POLICY_SATISFIED' },
      schemaProblems: [], strictJson: true, decisionCorrect: true, reasonCorrect: true,
      jointCorrect: true, attributesCorrect: true, actionCorrect: true,
      purposeCorrect: true, adversarial: false, latencyMs: 10, decisionDisagreement: false,
    },
    {
      expected: { decision: 'deny', reasonCode: 'NOT_ASSIGNED' },
      prediction: { decision: 'allow', reasonCode: 'POLICY_SATISFIED' },
      schemaProblems: [], strictJson: true, decisionCorrect: false, reasonCorrect: false,
      jointCorrect: false, attributesCorrect: false, actionCorrect: true,
      purposeCorrect: true, adversarial: true, latencyMs: 20, decisionDisagreement: true,
    },
  ];
  const metrics = summarise(rows);
  assert.equal(metrics.decisionAccuracy, 0.5);
  assert.equal(metrics.falseAllowCount, 1);
  assert.equal(metrics.decisionDisagreementRate, 0.5);
  assert.equal(metrics.decisionMacroF1, 0.3333);
  assert.equal(metrics.reasonMacroF1, 0.3333);
});
