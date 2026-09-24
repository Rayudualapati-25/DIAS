'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/policy');
const evaluatorContract = require('../experiments/llm_policy_engine/policy_prompts');
const { messagesFor } = require('../src/modelClient');

const input = {
  query: 'I need to view REC-FIR-001 for my ongoing investigation.',
  subject: {
    mspId: 'PoliceMSP',
    role: 'investigating-officer',
    clearance: 'high',
    jurisdiction: 'district-north',
    credentialStatus: 'active',
    caseAssignments: 'CASE-2026-001',
  },
  record: {
    recordId: 'REC-FIR-001',
    caseId: 'CASE-2026-001',
    recordType: 'fir',
    sensitivityLevel: 'medium',
    jurisdiction: 'district-north',
    sealed: false,
    juvenileFlag: false,
    victimProtectionFlag: false,
  },
  requestContext: { approvalTokenPresent: false, emergencyFlag: false },
};

test('the interface and the offline evaluator share one prompt contract', () => {
  assert.equal(evaluatorContract, policy);
  assert.equal(evaluatorContract.SYSTEM_PROMPT, policy.SYSTEM_PROMPT);
  assert.equal(evaluatorContract.MODEL_VERSION, policy.MODEL_VERSION);
});

test('the same input builds a byte-identical prompt every time', () => {
  const first = messagesFor(input);
  const second = messagesFor({ ...input });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('the runtime prompt carries no policy rules, only the reason vocabulary', () => {
  const [system] = messagesFor(input);
  assert.ok(system.content.includes('POLICY_SATISFIED'));
  assert.ok(!system.content.includes('ORDERED POLICY RULES'));
  assert.ok(policy.RULES_SYSTEM_PROMPT.includes('ORDERED POLICY RULES'));
});
