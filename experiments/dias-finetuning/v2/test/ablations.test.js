'use strict';

/**
 * Ablation correctness.
 *
 * An ablation is only interpretable if it changes exactly one thing. These tests
 * assert that every ablated prompt is byte-identical to the control outside the
 * region it redacts, that the redaction actually removed the information, and
 * that the answer never leaks into the prompt.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPolicyContextProvider } = require('../../../../backend/src/dias/policyContextProvider');
const { ABLATIONS, ABLATION_NAMES, WITHHELD, ablatedMessages, sections } = require('../eval/ablations');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const provider = createPolicyContextProvider({});

const examples = fs
  .readFileSync(path.join(DATASET, 'test-decision-balanced.cases.jsonl'), 'utf8')
  .split('\n').filter(Boolean).slice(0, 8).map((line) => JSON.parse(line));

const inputsFor = (example) => ({
  verifiedRequest: example.verifiedRequest,
  policyContext: provider.assemble(example.verifiedRequest),
  justification: example.justification,
});

test('the control is exactly what the live prompt module produces', () => {
  const { buildRecommendationMessages } = require('../../../../backend/src/dias/recommendationPrompt');
  for (const example of examples) {
    const inputs = inputsFor(example);
    assert.deepEqual(ablatedMessages('full', inputs), buildRecommendationMessages(inputs));
  }
});

test('every ablation leaves the system prompt untouched', () => {
  for (const example of examples) {
    const inputs = inputsFor(example);
    const control = ablatedMessages('full', inputs)[0].content;
    for (const name of ABLATION_NAMES) {
      assert.equal(ablatedMessages(name, inputs)[0].content, control, `${name} changed the system prompt`);
    }
  }
});

test('each ablation changes only its own section', () => {
  const unchanged = {
    'no-requester': ['policy', 'justification'],
    'no-resource': ['policy', 'justification'],
    'no-action-purpose': ['policy', 'justification'],
    'no-policy': ['requestJson', 'justification'],
    'no-justification': ['requestJson', 'policy'],
  };
  for (const example of examples) {
    const inputs = inputsFor(example);
    const control = sections(ablatedMessages('full', inputs)[1].content);
    for (const [name, keep] of Object.entries(unchanged)) {
      const ablated = sections(ablatedMessages(name, inputs)[1].content);
      for (const key of keep) {
        assert.equal(ablated[key], control[key], `${name} also changed ${key}`);
      }
    }
  }
});

test('the redacted information is genuinely gone', () => {
  const example = examples[0];
  const inputs = inputsFor(example);
  const requester = example.verifiedRequest.requester;
  const resource = example.verifiedRequest.resource;

  const noRequester = sections(ablatedMessages('no-requester', inputs)[1].content).requestJson;
  assert.ok(!noRequester.includes(`"role":"${requester.role}"`), 'the role survived redaction');
  assert.ok(!noRequester.includes(`"clearance":"${requester.clearance}"`), 'the clearance survived');
  // The resource block must still be intact in that same JSON.
  assert.ok(noRequester.includes(`"recordType":"${resource.recordType}"`),
    'no-requester must not disturb the resource block');

  const noResource = sections(ablatedMessages('no-resource', inputs)[1].content).requestJson;
  assert.ok(!noResource.includes(`"recordType":"${resource.recordType}"`), 'the record type survived');
  assert.ok(noResource.includes(`"role":"${requester.role}"`),
    'no-resource must not disturb the requester block');

  const noPolicy = sections(ablatedMessages('no-policy', inputs)[1].content).policy;
  assert.ok(!noPolicy.includes('GP-JURIS:C1@v1'), 'a clause reference survived policy redaction');
  assert.ok(noPolicy.includes(WITHHELD));

  const noJustification = sections(ablatedMessages('no-justification', inputs)[1].content).justification;
  assert.ok(!noJustification.includes(example.justification.slice(0, 30)),
    'the justification text survived redaction');
});

test('redaction keeps the JSON parseable and the keys present', () => {
  // A model handed malformed JSON would fail for the wrong reason.
  for (const name of ['no-requester', 'no-resource', 'no-action-purpose']) {
    const parsed = JSON.parse(sections(ablatedMessages(name, inputsFor(examples[0]))[1].content).requestJson);
    assert.deepEqual(Object.keys(parsed).sort(), ['request', 'requester', 'resource']);
    assert.equal(Object.keys(parsed.requester).length, 9);
    assert.equal(Object.keys(parsed.resource).length, 10);
    assert.equal(Object.keys(parsed.request).length, 4);
  }
});

test('no-action-purpose keeps the fields it is not ablating', () => {
  const example = examples[0];
  const parsed = JSON.parse(
    sections(ablatedMessages('no-action-purpose', inputsFor(example))[1].content).requestJson);
  assert.equal(parsed.request.action, WITHHELD);
  assert.equal(parsed.request.purpose, WITHHELD);
  assert.equal(parsed.request.emergencyFlag, example.verifiedRequest.request.emergencyFlag);
  assert.equal(parsed.request.approvalTokenPresent, example.verifiedRequest.request.approvalTokenPresent);
});

test('no ablated prompt contains the answer', () => {
  // The system prompt legitimately contains the strings "ALLOW" and "DENY" as
  // part of the response schema, so a bare class-name search would be a false
  // positive. What must never appear is the completion itself or its reason.
  for (const example of examples) {
    const inputs = inputsFor(example);
    const completion = JSON.stringify(example.label);
    for (const name of ABLATION_NAMES) {
      const [system, user] = ablatedMessages(name, inputs);
      const text = `${system.content}\n${user.content}`;
      assert.ok(!text.includes(completion), `${name} leaked the completion`);
      assert.ok(!text.includes(example.label.reason), `${name} leaked the reason sentence`);
      assert.ok(!text.includes(`"reason_code":"${example.label.reason_code}"`),
        `${name} leaked the reason code as an answer field`);
    }
  }
});

test('every ablation declares what it expects, so a result can be judged', () => {
  for (const name of ABLATION_NAMES) {
    assert.equal(typeof ABLATIONS[name].label, 'string');
    assert.ok(ABLATIONS[name].expectation.length > 10, `${name} has no stated expectation`);
  }
});
