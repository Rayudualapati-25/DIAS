'use strict';

/**
 * The V6 comparison adapter.
 *
 * The single most important property: `escalate` must never become a DENY.
 * Folding it in would credit the SEAL-era model with a safe answer it did not
 * give, on exactly the metric the whole design is judged by.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ADAPTATIONS, CODE_MAP, parseV6, sealRecord, sealSubject, v6Messages } = require('../eval/v6-adapter');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const examples = fs
  .readFileSync(path.join(DATASET, 'test-decision-balanced.cases.jsonl'), 'utf8')
  .split('\n').filter(Boolean).slice(0, 5).map(JSON.parse);

const answer = (over = {}) => JSON.stringify({
  action: 'view', purpose: 'investigation', decision: 'deny',
  reasonCode: 'NOT_ASSIGNED', policyVersion: 'crime-policy-v2',
  modelVersion: 'qwen3-14b-seba-lora-v6', ...over,
});

test('escalate becomes an absent recommendation, never a DENY', () => {
  const parsed = parseV6(answer({ decision: 'escalate', reasonCode: 'SEALED_RECORD' }));
  assert.equal(parsed.recommendation, null);
  assert.equal(parsed.status, 'ESCALATE_NOT_IN_BINARY_CONTRACT');
  assert.equal(parsed.sealDecision, 'escalate');
});

test('allow and deny map to the binary classes', () => {
  assert.equal(parseV6(answer({ decision: 'allow', reasonCode: 'POLICY_SATISFIED' }))
    .recommendation.recommendation, 'ALLOW');
  assert.equal(parseV6(answer({ decision: 'deny' })).recommendation.recommendation, 'DENY');
});

test('reason codes carry across, and an unknown one is an invalid answer', () => {
  assert.equal(parseV6(answer()).recommendation.reason_code, 'NOT_ASSIGNED');
  assert.equal(parseV6(answer({ reasonCode: 'MODEL_POLICY_DISAGREEMENT' })).status, 'INVALID_OUTPUT');
  assert.equal(parseV6(answer({ reasonCode: 'MADE_UP' })).status, 'INVALID_OUTPUT');
});

test('fields V6 does not produce are left empty rather than fabricated', () => {
  const rec = parseV6(answer()).recommendation;
  assert.equal(rec.reason, '');
  assert.deepEqual(rec.policy_refs, []);
  assert.deepEqual(rec.missing_evidence, []);
  assert.deepEqual(rec.review_flags, []);
});

test('unparseable and non-JSON answers are INVALID_OUTPUT', () => {
  assert.equal(parseV6('I think this should be denied.').status, 'INVALID_OUTPUT');
  assert.equal(parseV6('').status, 'INVALID_OUTPUT');
  assert.equal(parseV6(answer({ decision: 'maybe' })).status, 'INVALID_OUTPUT');
});

test('a thinking block and a code fence are tolerated, as they are for V7', () => {
  assert.equal(parseV6(`<think></think>${answer()}`).recommendation.recommendation, 'DENY');
  assert.equal(parseV6('```json\n' + answer() + '\n```').recommendation.recommendation, 'DENY');
});

test('the action and purpose are withheld from the V6 prompt, as SEAL intended', () => {
  for (const example of examples) {
    const [, user] = v6Messages(example);
    const context = user.content.slice(user.content.indexOf('TRUSTED REQUEST CONTEXT:'));
    assert.ok(!context.includes('"action"'), 'action leaked into the V6 request context');
    assert.ok(!context.includes('"purpose"'), 'purpose leaked into the V6 request context');
    assert.ok(context.includes('emergencyFlag'), 'the rest of the context must survive');
  }
});

test('every policy-relevant fact survives the re-projection', () => {
  for (const example of examples) {
    const subject = sealSubject(example.verifiedRequest);
    const record = sealRecord(example.verifiedRequest);
    assert.deepEqual(subject, example.verifiedRequest.requester);
    assert.deepEqual(record, example.verifiedRequest.resource);
  }
});

test('the V6 prompt never contains the answer', () => {
  for (const example of examples) {
    const text = v6Messages(example).map((m) => m.content).join('\n');
    assert.ok(!text.includes(JSON.stringify(example.label)));
    assert.ok(!text.includes(example.label.reason));
  }
});

test('every adaptation is documented, so the comparison can be judged', () => {
  assert.ok(ADAPTATIONS.length >= 4);
  assert.ok(ADAPTATIONS.some((a) => /escalate/i.test(a)));
  assert.ok(ADAPTATIONS.some((a) => /action or purpose|action and purpose/i.test(a)));
});

test('the code map covers exactly the reason codes the v2 policy defines', () => {
  const { loadBundle } = require('../../../../policies/lib/bundle');
  const policyCodes = Object.keys(loadBundle().bundle.reasonCodes).sort();
  assert.deepEqual(Object.values(CODE_MAP).sort(), policyCodes);
});
