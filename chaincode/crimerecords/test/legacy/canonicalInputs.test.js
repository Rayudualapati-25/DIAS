'use strict';

// LEGACY (SEAL / pre-DIAS): exercises retained modules that the DIAS runtime no longer
// loads and that deployCC.sh excludes from the chaincode package (see architectureGuard.test.js).

/**
 * The safety guard must evaluate policy on CANONICAL request facts.
 *
 * Before this suite existed the deterministic check consumed the model's own
 * `action` and `purpose`, so a misread request produced a policy result computed
 * from that same misreading and the two trivially agreed. These tests pin the
 * corrected boundary: the operation and purpose come from the request the
 * requester committed, the model's reading of them is compared rather than
 * trusted, and no disagreement of any kind may turn into an automatic grant or
 * denial.
 */

const { expect } = require('chai');
const chai = require('chai');
chai.use(require('chai-as-promised'));

const {
  MODEL_REASON_CODES,
  SYSTEM_REASON_CODES,
  REASON_DECISION,
  canonicalRequest,
  deriveEffectiveClassification,
  materializeDecision,
} = require('../../lib/policy/controlledDecision');
const { evaluate } = require('../../lib/policy/policyEngine');
const { promptRequestContext } = require('../../../../backend/src/llm/policyPrompt');

const MODEL_VERSION = 'qwen3-14b-seba-lora-v6';
const POLICY_VERSION = 'crime-policy-v2';

/** An assigned inspector in the record's own district: the policy allows this. */
function allowingContext(overrides = {}) {
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

/** The compact classification the model returns. */
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

/** What the deterministic engine says about a context, using canonical facts. */
function policyTruth(trusted) {
  const canonical = canonicalRequest(trusted);
  return evaluate(trusted.subject, trusted.record, canonical.action, {
    purpose: canonical.purpose,
    emergencyFlag: false,
    approvalToken: undefined,
  });
}

describe('canonical request facts drive the deterministic safety check', () => {
  describe('TEST 1 - the model read the request the way it was committed', () => {
    it('keeps the model result when action, purpose, decision and reason all agree', () => {
      const trusted = allowingContext();
      const result = deriveEffectiveClassification(classification(), trusted);

      expect(result.modelInputAgreement, 'inputs agree').to.equal(true);
      expect(result.modelPolicyAgreement, 'policy agrees').to.equal(true);
      expect(result.effective.decision).to.equal('allow');
      expect(result.effective.reasonCode).to.equal('POLICY_SATISFIED');
      expect(policyTruth(trusted).decision).to.equal('allow');
    });
  });

  describe('TEST 2 - the model read a different operation than the one invoked', () => {
    it('escalates when the canonical action is view and the model says export', () => {
      const trusted = allowingContext();
      const result = deriveEffectiveClassification(
        classification({ action: 'export' }), trusted
      );

      expect(result.modelInputAgreement).to.equal(false);
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_INPUT_DISAGREEMENT');
    });

    it('evaluates policy on the canonical action, not the one the model reported', () => {
      // A constable may view a FIR but has no export permission at all. If the
      // engine consumed the model's action it would return RBAC_NO_PERMISSION;
      // reading the canonical action it returns the allow the request deserves.
      const trusted = allowingContext({
        subject: { role: 'constable', clearance: 'medium' },
      });
      const result = deriveEffectiveClassification(
        classification({ action: 'export', reasonCode: 'RBAC_NO_PERMISSION', decision: 'deny' }),
        trusted
      );

      expect(result.policyResult.reasonCode, 'policy used the canonical view action')
        .to.equal('POLICY_SATISFIED');
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_INPUT_DISAGREEMENT');
    });

    it('escalates when the model reports a different purpose than the one committed', () => {
      const trusted = allowingContext();
      const result = deriveEffectiveClassification(
        classification({ purpose: 'audit-review' }), trusted
      );

      expect(result.modelInputAgreement).to.equal(false);
      expect(result.effective.reasonCode).to.equal('MODEL_INPUT_DISAGREEMENT');
    });
  });

  describe('TEST 3 - trusted context implies DENY, the model proposes ALLOW', () => {
    it('escalates rather than granting', () => {
      // Cross-district: rule 6 denies for every role.
      const trusted = allowingContext({
        record: { jurisdiction: 'district-south' },
      });
      expect(policyTruth(trusted).decision).to.equal('deny');

      const result = deriveEffectiveClassification(classification(), trusted);
      expect(result.modelInputAgreement, 'the model read the request correctly').to.equal(true);
      expect(result.modelPolicyAgreement).to.equal(false);
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_POLICY_DISAGREEMENT');
    });
  });

  describe('TEST 4 - trusted context implies ALLOW, the model proposes DENY', () => {
    it('escalates rather than denying', () => {
      const trusted = allowingContext();
      expect(policyTruth(trusted).decision).to.equal('allow');

      const result = deriveEffectiveClassification(
        classification({ decision: 'deny', reasonCode: 'INSUFFICIENT_CLEARANCE' }), trusted
      );
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_POLICY_DISAGREEMENT');
    });
  });

  describe('TEST 5 - the decision matches but the reason code conflicts', () => {
    it('escalates an ALLOW carried by a denial reason code', () => {
      const trusted = allowingContext();
      const result = deriveEffectiveClassification(
        classification({ decision: 'allow', reasonCode: 'INSUFFICIENT_CLEARANCE' }), trusted
      );

      expect(REASON_DECISION.INSUFFICIENT_CLEARANCE).to.equal('deny');
      expect(result.modelPolicyAgreement).to.equal(false);
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_POLICY_DISAGREEMENT');
    });

    it('escalates a reason code the policy did not reach, even at the same decision', () => {
      // Both codes deny, so the decision matches; the reason does not.
      const trusted = allowingContext({ record: { jurisdiction: 'district-south' } });
      expect(policyTruth(trusted).reasonCode).to.equal('CROSS_JURISDICTION');

      const result = deriveEffectiveClassification(
        classification({ decision: 'deny', reasonCode: 'NOT_ASSIGNED' }), trusted
      );
      expect(result.effective.decision).to.equal('escalate');
      expect(result.effective.reasonCode).to.equal('MODEL_POLICY_DISAGREEMENT');
    });
  });

  describe('TEST 6 - purpose is established independently of the model', () => {
    it('takes the purpose the requester committed, never the model classification', () => {
      const trusted = allowingContext({ requestContext: { purpose: 'audit-review' } });
      expect(canonicalRequest(trusted).purpose).to.equal('audit-review');

      const result = deriveEffectiveClassification(
        classification({ purpose: 'investigation' }), trusted
      );
      expect(result.canonical.purpose, 'policy read the committed purpose')
        .to.equal('audit-review');
      expect(result.effective.reasonCode).to.equal('MODEL_INPUT_DISAGREEMENT');
    });

    it('never shows the canonical operation or purpose to the model', () => {
      // If the prompt carried them the model would echo them back and the
      // comparison above would prove nothing.
      const shown = promptRequestContext(allowingContext().requestContext);
      expect(shown).to.not.have.property('action');
      expect(shown).to.not.have.property('purpose');
    });

    it('rejects a purpose outside the policy vocabulary before inference', () => {
      // The chaincode allow-list enforces this at request time; here we confirm
      // the engine itself refuses an unknown purpose rather than defaulting.
      const trusted = allowingContext({ requestContext: { purpose: 'marketing' } });
      expect(policyTruth(trusted).reasonCode).to.equal('INVALID_PURPOSE');
    });
  });

  describe('TEST 7 - the explanation describes the escalation, not the proposal', () => {
    it('explains a policy disagreement without reusing the proposed ALLOW reason', () => {
      const trusted = allowingContext({ record: { jurisdiction: 'district-south' } });
      const derived = deriveEffectiveClassification(classification(), trusted);
      const decision = materializeDecision(derived.effective, trusted);

      expect(decision.decision).to.equal('escalate');
      expect(decision.reasonCode).to.equal('MODEL_POLICY_DISAGREEMENT');
      expect(decision.explanation).to.match(/does not match the deterministic policy result/);
      expect(decision.explanation).to.not.match(/every applicable policy condition is satisfied/);
      expect(decision.decisiveAttributes).to.deep.equal([
        'model.decision', 'model.reasonCode',
        'policy.expectedDecision', 'policy.expectedReasonCode',
      ]);
    });

    it('explains an input disagreement in its own terms', () => {
      const trusted = allowingContext();
      const derived = deriveEffectiveClassification(
        classification({ action: 'export' }), trusted
      );
      const decision = materializeDecision(derived.effective, trusted);

      expect(decision.decision).to.equal('escalate');
      expect(decision.reasonCode).to.equal('MODEL_INPUT_DISAGREEMENT');
      expect(decision.explanation).to.match(/model-interpreted action or purpose/);
      expect(decision.decisiveAttributes).to.include('request.action');
    });

    it('records the committed request, not the model reading, in parsedRequest', () => {
      const trusted = allowingContext();
      const derived = deriveEffectiveClassification(
        classification({ action: 'export', purpose: 'audit-review' }), trusted
      );
      const decision = materializeDecision(derived.effective, trusted);

      expect(decision.parsedRequest.action).to.equal('view');
      expect(decision.parsedRequest.purpose).to.equal('investigation');
    });
  });

  describe('TEST 8 - disagreement never substitutes the deterministic outcome', () => {
    const cases = [
      {
        name: 'model ALLOW against a policy DENY',
        trusted: allowingContext({ record: { jurisdiction: 'district-south' } }),
        advisory: classification(),
      },
      {
        name: 'model DENY against a policy ALLOW',
        trusted: allowingContext(),
        advisory: classification({ decision: 'deny', reasonCode: 'CROSS_JURISDICTION' }),
      },
      {
        name: 'model DENY against a policy DENY for a different reason',
        trusted: allowingContext({ record: { jurisdiction: 'district-south' } }),
        advisory: classification({ decision: 'deny', reasonCode: 'NOT_ASSIGNED' }),
      },
      {
        name: 'model misread the operation',
        trusted: allowingContext(),
        advisory: classification({ action: 'annotate' }),
      },
    ];

    cases.forEach(({ name, trusted, advisory }) => {
      it(`escalates instead of adopting the policy outcome: ${name}`, () => {
        const derived = deriveEffectiveClassification(advisory, trusted);
        const decision = materializeDecision(derived.effective, trusted);

        expect(decision.decision, 'every disagreement is an escalation').to.equal('escalate');
        expect(decision.decision).to.not.equal(derived.policyResult.decision === 'escalate'
          ? '__never__' : derived.policyResult.decision);
        expect(SYSTEM_REASON_CODES).to.include(decision.reasonCode);
      });
    });

    it('exhaustively: no advisory over the whole reason vocabulary ever yields a', () => {
      // ... deterministic allow or deny that the model did not itself propose.
      const trusted = allowingContext();
      const truth = policyTruth(trusted);
      MODEL_REASON_CODES.forEach((reasonCode) => {
        const advisory = classification({
          reasonCode, decision: REASON_DECISION[reasonCode],
        });
        const derived = deriveEffectiveClassification(advisory, trusted);
        const agreed = reasonCode === truth.reasonCode;
        expect(derived.effective.decision).to.equal(
          agreed ? REASON_DECISION[reasonCode] : 'escalate'
        );
      });
    });

    it('never lets the model emit a system reason code itself', () => {
      SYSTEM_REASON_CODES.forEach((code) => {
        expect(MODEL_REASON_CODES).to.not.include(code);
      });
    });
  });
});
