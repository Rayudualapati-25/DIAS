'use strict';

// LEGACY (SEAL / pre-DIAS): exercises retained modules that the DIAS runtime no longer
// loads and that deployCC.sh excludes from the chaincode package (see architectureGuard.test.js).

const { expect } = require('chai');
const {
  MODEL_REASON_CODES,
  REASON_DECISION,
  REASON_DETAILS,
  SYSTEM_REASON_CODES,
  deriveEffectiveClassification,
  materializeDecision,
} = require('../../lib/policy/controlledDecision');
const { evaluate } = require('../../lib/policy/policyEngine');
const {
  validateInference,
  validateModelClassification,
  validateModelDecision,
} = require('../../lib/policy/llmDecisionProtocol');
const { hashObject } = require('../../lib/util/validate');

const POLICY_VERSION = 'crime-policy-v2';
const MODEL_VERSION = 'qwen3-14b-seba-lora-v6';

function trusted(overrides = {}) {
  return {
    subject: {
      mspId: 'PoliceMSP',
      role: 'inspector',
      jurisdiction: 'district-north',
      clearance: 'high',
      credentialStatus: 'active',
      caseAssignments: 'CASE-1',
      ...(overrides.subject || {}),
    },
    record: {
      recordId: 'FIR-1',
      caseId: 'CASE-1',
      recordType: 'fir',
      sensitivityLevel: 'medium',
      jurisdiction: 'district-north',
      sealed: false,
      juvenileFlag: false,
      victimProtectionFlag: false,
      ...(overrides.record || {}),
    },
    requestContext: {
      action: 'view',
      purpose: 'investigation',
      ...(overrides.requestContext || {}),
    },
  };
}

function classification(overrides = {}) {
  return {
    action: 'view',
    purpose: 'investigation',
    decision: 'allow',
    reasonCode: 'POLICY_SATISFIED',
    policyVersion: POLICY_VERSION,
    modelVersion: MODEL_VERSION,
    ...overrides,
  };
}

function policyOutput(input) {
  return evaluate(input.subject, input.record, input.requestContext.action, {
    purpose: input.requestContext.purpose,
    emergencyFlag: Boolean(input.requestContext.emergencyFlag),
    approvalToken: input.requestContext.approvalTokenPresent ? 'ledger-approved' : undefined,
  });
}

function inferenceFor(decision, advisory = classification()) {
  return {
    adapterHash: 'a'.repeat(64),
    latencyMs: 123,
    modelClassification: advisory,
    modelVersion: decision.modelVersion,
    outputHash: hashObject(decision),
    promptHash: 'b'.repeat(64),
    servedModel: 'mlx-community/Qwen3-14B-4bit',
  };
}

function expectRematerializationRejection(tamper) {
  const input = REASON_CASES.POLICY_SATISFIED;
  const advisory = classification();
  const original = materializeDecision(advisory, input);
  const changed = tamper(original);
  const changedInference = inferenceFor(changed, advisory);
  expect(() => validateModelDecision(changed, input)).to.not.throw();
  expect(() => validateInference(changedInference, changed, input))
    .to.throw(/does not match the independently derived policy result/);
}

const REASON_CASES = Object.freeze({
  CRED_NOT_ACTIVE: trusted({ subject: { credentialStatus: 'revoked' } }),
  INVALID_PURPOSE: trusted({ requestContext: { purpose: 'curiosity' } }),
  RBAC_NO_PERMISSION: trusted({ subject: { role: 'constable' }, record: { recordType: 'chargesheet' } }),
  SEALED_RECORD: trusted({ record: { sealed: true } }),
  JUVENILE_PROTECTED: trusted({ subject: { role: 'constable' }, record: { juvenileFlag: true } }),
  VICTIM_DATA_NOT_NECESSARY: trusted({
    subject: { mspId: 'ForensicsMSP', role: 'lab-analyst', clearance: 'high' },
    record: { recordType: 'evidence', victimProtectionFlag: true },
    requestContext: { purpose: 'forensic-analysis' },
  }),
  CROSS_JURISDICTION: trusted({ record: { jurisdiction: 'district-south' } }),
  NOT_ASSIGNED: trusted({ subject: { caseAssignments: null } }),
  INSUFFICIENT_CLEARANCE: trusted({ subject: { clearance: 'low' }, record: { sensitivityLevel: 'high' } }),
  POLICY_SATISFIED: trusted(),
});

describe('structured explanation materialization', () => {
  it('defines explanation details for every active reason code', () => {
    const allReasons = [...MODEL_REASON_CODES, ...SYSTEM_REASON_CODES];
    expect(Object.keys(REASON_DETAILS).sort()).to.deep.equal(allReasons.sort());
    allReasons.forEach((reasonCode) => {
      expect(REASON_DECISION).to.have.property(reasonCode);
      expect(REASON_DETAILS[reasonCode].decisiveAttributes).to.be.an('array').that.is.not.empty;
      expect(REASON_DETAILS[reasonCode].explanation).to.be.a('string').and.not.equal('');
    });
  });

  it('TEST 1 - materializes the correct ALLOW explanation', () => {
    const input = REASON_CASES.POLICY_SATISFIED;
    const decision = materializeDecision(classification(), input);
    expect(decision).to.include({
      decision: 'allow',
      reasonCode: 'POLICY_SATISFIED',
      explanation: 'Access is allowed because the active credential and every applicable purpose, permission, protection, jurisdiction, assignment, and clearance condition are satisfied.',
    });
    expect(decision.decisiveAttributes).to.deep.equal(policyOutput(input).decisiveAttributes);
    expect(decision.decisiveAttributes).to.include.members([
      'subject.credentialStatus', 'subject.mspId', 'subject.role', 'action',
      'object.recordType', 'object.sealed', 'object.juvenileFlag',
      'object.victimProtectionFlag', 'subject.jurisdiction', 'object.jurisdiction',
      'subject.caseAssignments', 'object.caseId', 'subject.clearance',
      'object.sensitivityLevel', 'env.purpose',
    ]);
    expect(decision.counterfactual).to.contain('automatic ALLOW would change');
  });

  it('TEST 2 - materializes the correct DENY explanation', () => {
    const input = REASON_CASES.INSUFFICIENT_CLEARANCE;
    const advisory = classification({ decision: 'deny', reasonCode: 'INSUFFICIENT_CLEARANCE' });
    const decision = materializeDecision(advisory, input);
    expect(decision).to.include({
      decision: 'deny',
      reasonCode: 'INSUFFICIENT_CLEARANCE',
      explanation: 'Access is denied because the authenticated clearance is below the record sensitivity.',
    });
    expect(decision.decisiveAttributes).to.deep.equal(['subject.clearance', 'object.sensitivityLevel']);
    expect(decision.counterfactual).to.contain("requester clearance were 'high' or higher");
  });

  it('TEST 3 - materializes the correct normal ESCALATE explanation', () => {
    const input = REASON_CASES.SEALED_RECORD;
    const advisory = classification({ decision: 'escalate', reasonCode: 'SEALED_RECORD' });
    const decision = materializeDecision(advisory, input);
    expect(decision).to.include({
      decision: 'escalate',
      reasonCode: 'SEALED_RECORD',
      explanation: 'Access is escalated because the record is sealed and the requester is outside the court organization.',
    });
    expect(decision.decisiveAttributes).to.deep.equal(['object.sealed', 'subject.mspId']);
    expect(decision.counterfactual).to.contain('record were not sealed or the requester belonged to CourtMSP');
  });

  it('TEST 4 - explains MODEL_POLICY_DISAGREEMENT from proposed ALLOW', () => {
    const input = REASON_CASES.CROSS_JURISDICTION;
    const derived = deriveEffectiveClassification(classification(), input);
    const decision = materializeDecision(derived.effective, input);
    expect(decision).to.include({
      decision: 'escalate',
      reasonCode: 'MODEL_POLICY_DISAGREEMENT',
    });
    expect(decision.explanation).to.contain('does not match the deterministic policy result');
    expect(decision.explanation).to.not.contain('every applicable policy condition is satisfied');
    expect(decision.decisiveAttributes).to.deep.equal([
      'model.decision', 'model.reasonCode',
      'policy.expectedDecision', 'policy.expectedReasonCode',
    ]);
    expect(decision.counterfactual).to.contain('exactly matched');
  });

  it('TEST 5 - explains MODEL_POLICY_DISAGREEMENT from proposed DENY', () => {
    const input = REASON_CASES.POLICY_SATISFIED;
    const advisory = classification({ decision: 'deny', reasonCode: 'INSUFFICIENT_CLEARANCE' });
    const derived = deriveEffectiveClassification(advisory, input);
    const decision = materializeDecision(derived.effective, input);
    expect(decision).to.include({
      decision: 'escalate',
      reasonCode: 'MODEL_POLICY_DISAGREEMENT',
    });
    expect(decision.explanation).to.contain('does not match the deterministic policy result');
    expect(decision.explanation).to.not.contain('authenticated clearance is below');
  });

  it('materializes MODEL_INPUT_DISAGREEMENT from the effective input-conflict reason', () => {
    const input = REASON_CASES.POLICY_SATISFIED;
    const derived = deriveEffectiveClassification(classification({ action: 'export' }), input);
    const decision = materializeDecision(derived.effective, input);
    expect(decision).to.include({
      decision: 'escalate',
      reasonCode: 'MODEL_INPUT_DISAGREEMENT',
    });
    expect(decision.decisiveAttributes).to.deep.equal([
      'model.action', 'model.purpose', 'request.action', 'request.purpose',
    ]);
    expect(decision.counterfactual).to.contain('committed action and purpose');
  });

  it('TEST 6 - rejects a model decision that conflicts with its reason', () => {
    const bad = classification({ decision: 'allow', reasonCode: 'INSUFFICIENT_CLEARANCE' });
    const expectedDecision = materializeDecision(classification(), trusted());
    expect(() => validateModelClassification(bad, expectedDecision))
      .to.throw(/reasonCode is inconsistent with decision/);
  });

  it('TEST 7 - detects tampered explanation text after the attacker recomputes outputHash', () => {
    expectRematerializationRejection((decision) => ({
      ...decision,
      explanation: 'Access is allowed for an invented reason.',
    }));
  });

  it('TEST 8 - detects tampered decisiveAttributes after the attacker recomputes outputHash', () => {
    expectRematerializationRejection((decision) => ({
      ...decision,
      decisiveAttributes: ['subject.role'],
    }));
  });

  it('TEST 9 - detects a tampered counterfactual after the attacker recomputes outputHash', () => {
    expectRematerializationRejection((decision) => ({
      ...decision,
      counterfactual: 'Contact an administrator.',
    }));
  });

  it('TEST 10 - rejects an unknown reason code', () => {
    const input = trusted();
    const expectedDecision = materializeDecision(classification(), input);
    const unknown = classification({ reasonCode: 'UNKNOWN_REASON' });
    expect(() => materializeDecision(unknown, input)).to.throw(/unknown policy reason/);
    expect(() => validateModelClassification(unknown, expectedDecision))
      .to.throw(/invalid reasonCode/);
  });

  it('exhaustively matches each model reason explanation to the policy evidence', () => {
    MODEL_REASON_CODES.forEach((reasonCode) => {
      const input = REASON_CASES[reasonCode];
      expect(input, `${reasonCode} fixture`).to.exist;
      const expected = policyOutput(input);
      expect(expected.reasonCode, reasonCode).to.equal(reasonCode);
      const decision = materializeDecision(classification({
        decision: REASON_DECISION[reasonCode],
        reasonCode,
        purpose: input.requestContext.purpose,
        action: input.requestContext.action,
      }), input);
      expect(decision.decision, reasonCode).to.equal(REASON_DECISION[reasonCode]);
      expect(decision.decisiveAttributes, reasonCode).to.deep.equal(expected.decisiveAttributes);
      expect(decision.counterfactual, reasonCode).to.equal(expected.counterfactual);
      expect(decision.counterfactual, `${reasonCode} counterfactual`)
        .to.be.a('string').and.not.equal('');
      expect(decision.explanation, reasonCode).to.equal(REASON_DETAILS[reasonCode].explanation);
    });
  });

  it('gives every system-generated escalation a policy-condition counterfactual', () => {
    const policyConflict = materializeDecision(
      deriveEffectiveClassification(classification(), REASON_CASES.CROSS_JURISDICTION).effective,
      REASON_CASES.CROSS_JURISDICTION
    );
    const inputConflict = materializeDecision(
      deriveEffectiveClassification(classification({ action: 'export' }), trusted()).effective,
      trusted()
    );
    [policyConflict, inputConflict].forEach((decision) => {
      expect(decision.decision).to.equal('escalate');
      expect(decision.counterfactual).to.be.a('string').and.not.equal('');
      expect(decision.counterfactual).to.not.match(/ask|contact|reviewer must/i);
    });
  });
});
