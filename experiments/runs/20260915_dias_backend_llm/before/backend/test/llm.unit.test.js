'use strict';

/**
 * Unit tests for the explainable-AI module.
 * These do NOT need Ollama running or the Fabric network up.
 */

const { expect } = require('chai');
const { buildPrompt, validate } = require('../src/llm/explain');
const template = require('../src/llm/template');

// A decision as it comes back from the ledger.
const DECISION = Object.freeze({
  decisionId: 'tx-abc',
  recordId: 'FIR-2026-0501',
  caseId: 'CASE-2026-001',
  action: 'view',
  subject: {
    mspId: 'PoliceMSP', role: 'constable', station: 'PS-Central',
    jurisdiction: 'district-north', clearance: 'low',
  },
  environment: { purpose: 'investigation', approvalTokenHash: null },
  explanation: {
    decision: 'escalate',
    reasonCode: 'INSUFFICIENT_CLEARANCE',
    decisiveAttributes: ['subject.clearance', 'object.sensitivityLevel'],
    counterfactual: "decision would change if requester clearance were 'medium' or higher",
    policyVersion: 'crime-policy-v2',
  },
  explanationHash: 'f'.repeat(64),
});

describe('template renderer (baseline and fallback)', () => {
  it('states the outcome, the reason and the decisive attributes', () => {
    const text = template.render(DECISION.explanation, {
      subject: DECISION.subject, environment: DECISION.environment,
      record: { recordType: 'fir', sensitivityLevel: 'medium' },
    });
    expect(text).to.contain('escalated');
    expect(text).to.contain('requester clearance');
    expect(text).to.contain('record sensitivity level');
    expect(text).to.contain('crime-policy-v2');
  });

  it('includes the counterfactual when there is one', () => {
    const text = template.render(DECISION.explanation, {});
    expect(text).to.contain('What would change the outcome');
  });

  it('is deterministic', () => {
    const a = template.render(DECISION.explanation, {});
    const b = template.render(DECISION.explanation, {});
    expect(a).to.equal(b);
  });

  it('handles an unknown reason code without crashing', () => {
    const text = template.render(
      { ...DECISION.explanation, reasonCode: 'BRAND_NEW_CODE' }, {});
    expect(text).to.contain('BRAND_NEW_CODE');
  });
});

describe('prompt construction', () => {
  it('includes the decision, reason and decisive attributes', () => {
    const prompt = buildPrompt(DECISION);
    expect(prompt).to.contain('DECISION: escalate');
    expect(prompt).to.contain('INSUFFICIENT_CLEARANCE');
    expect(prompt).to.contain('requester clearance');
  });

  it('never sends case contents or personal identifiers to the model', () => {
    // The privacy claim of the whole system: sensitive content stays out of
    // any extra component, including the LLM.
    const withSecrets = {
      ...DECISION,
      payload: { summary: 'CANARY-CASE-NARRATIVE', complainant: 'CANARY-NAME' },
      subject: { ...DECISION.subject, badgeId: 'CANARY-BADGE' },
      environment: { ...DECISION.environment, approvalToken: 'CANARY-TOKEN' },
    };
    const prompt = buildPrompt(withSecrets);
    for (const canary of ['CANARY-CASE-NARRATIVE', 'CANARY-NAME', 'CANARY-BADGE', 'CANARY-TOKEN']) {
      expect(prompt).to.not.contain(canary);
    }
  });
});

describe('grounding validation', () => {
  it('accepts a faithful explanation', () => {
    const text = 'Access was escalated for senior review because the requester ' +
      'clearance is below the record sensitivity level. A supervisor must decide.';
    expect(validate(text, DECISION).ok).to.equal(true);
  });

  it('rejects text that contradicts the recorded decision', () => {
    const result = validate('Access was allowed because everything checked out fine.', DECISION);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.contain('allowed');
  });

  it('rejects invented identifiers', () => {
    const text = 'Access was escalated for senior review because clearance is too low ' +
      'for record FIR-9999-0001 under this policy.';
    const result = validate(text, DECISION);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.contain('invented');
  });

  it('rejects an invented record type that was not supplied to the wording model', () => {
    const text = 'Access was escalated because clearance is below sensitivity. ' +
      'A case diary requires review before access can proceed.';
    const result = validate(text, DECISION);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.contain('unsupported record type');
  });

  it('allows the record and case ids that really belong to this decision', () => {
    const text = 'Access to FIR-2026-0501 in CASE-2026-001 was escalated for senior ' +
      'review because the requester clearance is below the record sensitivity level.';
    expect(validate(text, DECISION).ok).to.equal(true);
  });

  it('rejects assistant filler and AI self-reference', () => {
    expect(validate('Sure! Access was escalated for senior review because clearance was low.',
      DECISION).ok).to.equal(false);
    expect(validate('As an AI language model I think access was escalated for review here.',
      DECISION).ok).to.equal(false);
  });

  it('rejects text that is too short to explain anything', () => {
    expect(validate('Escalated.', DECISION).ok).to.equal(false);
  });

  it('rejects calling an escalated decision final (it is pending review)', () => {
    const text = 'Access was escalated for senior review because the requester clearance ' +
      'is below the record sensitivity level. This decision is final and cannot be changed.';
    const result = validate(text, DECISION);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.contain('final');
  });

  it('accepts an escalated explanation that says review is pending', () => {
    const text = 'Access was escalated for senior review because the requester clearance ' +
      'is below the record sensitivity level. A supervisor can still approve this request.';
    expect(validate(text, DECISION).ok).to.equal(true);
  });

  it('rejects blaming a factor that did not decide the request', () => {
    // Real failure seen from llama3.2:3b: an RBAC denial explained as low clearance.
    const rbacDenial = {
      ...DECISION,
      explanation: {
        ...DECISION.explanation,
        decision: 'deny',
        reasonCode: 'RBAC_NO_PERMISSION',
        decisiveAttributes: ['subject.role', 'action', 'object.recordType'],
        counterfactual: "role 'defense-counsel' has no 'view' permission on 'fir'",
      },
    };
    const text = 'The request was denied due to the requester low clearance level, which ' +
      'does not meet the permissions required to view this record type for that role.';
    const result = validate(text, rbacDenial);
    expect(result.ok).to.equal(false);
    expect(result.problems.join(' ')).to.contain('clearance');
  });

  it('accepts an RBAC denial that blames the right thing', () => {
    const rbacDenial = {
      ...DECISION,
      explanation: {
        ...DECISION.explanation,
        decision: 'deny',
        reasonCode: 'RBAC_NO_PERMISSION',
        decisiveAttributes: ['subject.role', 'action', 'object.recordType'],
        counterfactual: "role 'defense-counsel' has no 'view' permission on 'fir'",
      },
    };
    const text = 'The request was denied because the requester role holds no view ' +
      'permission for this record type. It would need a role that permits that action.';
    expect(validate(text, rbacDenial).ok).to.equal(true);
  });

  it('warns but still accepts text that drops the counterfactual', () => {
    // Incomplete is not the same as wrong: the text is shown, and the gap is
    // recorded so it can be reported as a quality metric.
    const text = 'Access was escalated for senior review because the requester clearance ' +
      'sits below the record sensitivity level for this request.';
    const result = validate(text, DECISION);
    expect(result.ok).to.equal(true);
    expect(result.warnings.join(' ')).to.contain('counterfactual');
  });
});
