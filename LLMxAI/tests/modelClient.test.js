'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, messagesFor } = require('../src/modelClient');
const { MODEL_VERSION, POLICY_VERSION } = require('../src/policy');

const input = {
  query: 'May I view the FIR for the active investigation?',
  profileId: 'user-sharma',
  subject: {
    mspId: 'PoliceMSP', role: 'investigating-officer', clearance: 'high',
    jurisdiction: 'district-north', credentialStatus: 'active', caseAssignments: 'CASE-2026-001',
  },
  record: {
    recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', recordType: 'fir',
    sensitivityLevel: 'medium', jurisdiction: 'district-north', sealed: false,
    juvenileFlag: false, victimProtectionFlag: false,
  },
  requestContext: { emergencyFlag: false, approvalTokenPresent: false },
};

test('sends rules-free model messages and returns the Qwen decision', async () => {
  let requestBody;
  const fetchImpl = async (_url, request) => {
    requestBody = JSON.parse(request.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      action: 'view', purpose: 'investigation', decision: 'allow',
      reasonCode: 'POLICY_SATISFIED', policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION,
    }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output = await decide(input, {
    fetchImpl,
    skipAdapterVerification: true,
    adapterHash: 'b'.repeat(64),
    adapterPath: '/tmp/test-adapter',
  });
  assert.equal(output.result.decision, 'allow');
  assert.equal(requestBody.temperature, 0);
  assert.equal(requestBody.messages.length, 2);
  assert.doesNotMatch(requestBody.messages[0].content, /Rules are evaluated/);
});

test('trusted attributes and untrusted query remain in separate prompt blocks', () => {
  const messages = messagesFor(input);
  assert.match(messages[1].content, /AUTHENTICATED SUBJECT:/);
  assert.match(messages[1].content, /LEDGER RESOURCE:/);
  assert.match(messages[1].content, /USER QUERY:/);
});
