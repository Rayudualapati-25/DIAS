'use strict';

/**
 * The evaluation adapter for prompt v2 (plan step 5). The dataset stores v1
 * cases, whose verified request carries the self-declared emergency flag and an
 * approval flag. Under v3 the flag becomes a requester claim and the approval
 * flag is dropped; the policy labels do not change (see the label-invariance
 * run in experiments/runs/).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { v3InputsFor, runDescriptor } = require('../eval/runner');
const {
  validateVerifiedRequest,
} = require('../../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const {
  validateRequesterClaims,
} = require('../../../../chaincode/crimerecords/lib/dias/requesterClaims');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const cases = fs.readFileSync(path.join(DATASET, 'test-decision-balanced.cases.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('every v1 case converts to a valid v3 context and claims', () => {
  for (const example of cases) {
    const { verifiedRequest, requesterClaims } = v3InputsFor(example);
    assert.deepEqual(validateVerifiedRequest(verifiedRequest), [], example.exampleId);
    assert.deepEqual(validateRequesterClaims(requesterClaims), [], example.exampleId);
    assert.deepEqual(verifiedRequest.requester, example.verifiedRequest.requester);
    assert.deepEqual(verifiedRequest.resource, example.verifiedRequest.resource);
    assert.deepEqual(verifiedRequest.request, {
      action: example.verifiedRequest.request.action, purpose: example.verifiedRequest.request.purpose,
    });
    assert.equal(requesterClaims.emergencyDeclared, example.verifiedRequest.request.emergencyFlag);
  }
});

test('the run descriptor names the prompt and the input adapter', () => {
  const common = {
    label: 'x', modelIdentity: {}, url: 'u', servedModel: 's', adapterPath: null, maxTokens: 512,
    datasetDir: DATASET,
  };
  const historical = runDescriptor(common);
  assert.equal(historical.promptVersion, 'dias-recommendation-prompt-v1');
  assert.equal(historical.inputAdapter, null);
  const current = runDescriptor({ ...common, prompt: 'v2' });
  assert.equal(current.promptVersion, 'dias-recommendation-prompt-v2');
  assert.match(current.inputAdapter, /approvalTokenPresent dropped/);
});
