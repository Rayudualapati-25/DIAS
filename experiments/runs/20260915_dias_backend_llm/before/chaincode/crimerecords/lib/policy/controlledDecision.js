'use strict';

/**
 * The controlled, deterministic half of the LLM decision protocol.
 *
 * Qwen supplies only an advisory compact classification. This module derives
 * the effective classification, explanation, and disagreement state from the
 * deployed policy. It is intentionally shared by the AI service and chaincode
 * so Fabric can independently reproduce the safety decision it is asked to
 * commit.
 */

const { evaluate } = require('./policyEngine');
const REASON_DECISION = require('./reasonDecisions');

const REASON_DETAILS = Object.freeze({
  CRED_NOT_ACTIVE: {
    decisiveAttributes: ['subject.credentialStatus'],
    counterfactual: () => 'the credential-status barrier would be removed if the requester credential status were "active"; remaining policy conditions would still be evaluated',
    explanation: 'Access is denied because the authenticated credential is not active.',
  },
  INVALID_PURPOSE: {
    decisiveAttributes: ['env.purpose'],
    counterfactual: () => 'the purpose barrier would be removed if purpose were one of [investigation, forensic-analysis, prosecution, judicial-proceeding, audit-review, defense-preparation]; remaining policy conditions would still be evaluated',
    explanation: 'Access is denied because the stated purpose is not permitted by the policy.',
  },
  RBAC_NO_PERMISSION: {
    decisiveAttributes: ['subject.mspId', 'subject.role', 'action', 'object.recordType'],
    counterfactual: ({ subject, record }, classification) =>
      `the RBAC barrier would be removed if organization '${subject.mspId}' and role '${subject.role}' were permitted to '${classification.action}' '${record.recordType}' records; remaining policy conditions would still be evaluated`,
    explanation: 'Access is denied because the authenticated organization and role have no permission for this action and record type.',
  },
  SEALED_RECORD: {
    decisiveAttributes: ['object.sealed', 'subject.mspId'],
    counterfactual: () => 'the seal barrier would be removed if the record were not sealed or the requester belonged to CourtMSP; remaining policy conditions would still be evaluated',
    explanation: 'Access is escalated because the record is sealed and the requester is outside the court organization.',
  },
  JUVENILE_PROTECTED: {
    decisiveAttributes: ['object.juvenileFlag', 'subject.role'],
    counterfactual: () => 'the juvenile-protection barrier would be removed if the record were not juvenile-protected or the requester held a role in the juvenile exception; remaining policy conditions would still be evaluated',
    explanation: 'Access is denied because the record is juvenile-protected and the authenticated role is not in the permitted exception.',
  },
  VICTIM_DATA_NOT_NECESSARY: {
    decisiveAttributes: ['object.victimProtectionFlag', 'subject.role'],
    counterfactual: () => 'the data-minimization barrier would be removed if the requested resource did not contain victim-protected raw data; remaining policy conditions would still be evaluated',
    explanation: 'Access is denied because a forensic laboratory role requested a record containing victim-protected raw data.',
  },
  CROSS_JURISDICTION: {
    decisiveAttributes: ['subject.jurisdiction', 'object.jurisdiction'],
    counterfactual: ({ record }) =>
      `the jurisdiction barrier would be removed if requester jurisdiction matched '${record.jurisdiction}'; remaining policy conditions would still be evaluated`,
    explanation: 'Access is denied because the requester and record jurisdictions do not match.',
  },
  NOT_ASSIGNED: {
    decisiveAttributes: ['subject.caseAssignments', 'object.caseId'],
    counterfactual: ({ record }) =>
      `the assignment barrier would be removed if case '${record.caseId}' were in the requester's active assignments; remaining policy conditions would still be evaluated`,
    explanation: 'Access is denied because the authenticated requester is not assigned to this case.',
  },
  INSUFFICIENT_CLEARANCE: {
    decisiveAttributes: ['subject.clearance', 'object.sensitivityLevel'],
    counterfactual: ({ record }) =>
      `access would satisfy the clearance condition if requester clearance were '${record.sensitivityLevel}' or higher`,
    explanation: 'Access is denied because the authenticated clearance is below the record sensitivity.',
  },
  MODEL_POLICY_DISAGREEMENT: {
    decisiveAttributes: [
      'model.decision', 'model.reasonCode',
      'policy.expectedDecision', 'policy.expectedReasonCode',
    ],
    counterfactual: () => 'automatic authorization could proceed without disagreement review if the model decision and reason code exactly matched the independently evaluated policy decision and reason code',
    explanation: 'Access is escalated because the model decision or reason code does not match the deterministic policy result.',
  },
  MODEL_INPUT_DISAGREEMENT: {
    decisiveAttributes: ['model.action', 'model.purpose', 'request.action', 'request.purpose'],
    counterfactual: () => 'automatic authorization could proceed without interpretation review if the model-interpreted action and purpose exactly matched the committed action and purpose',
    explanation: 'Access is escalated because the model-interpreted action or purpose does not match the committed request.',
  },
  POLICY_SATISFIED: {
    decisiveAttributes: [
      'subject.credentialStatus', 'env.purpose', 'subject.mspId', 'subject.role',
      'action', 'object.recordType', 'object.sealed', 'object.juvenileFlag',
      'object.victimProtectionFlag', 'subject.jurisdiction', 'object.jurisdiction',
      'subject.caseAssignments', 'object.caseId', 'subject.clearance',
      'object.sensitivityLevel',
    ],
    counterfactual: () => 'the automatic ALLOW would change if any applicable credential, purpose, RBAC, seal, protected-data, jurisdiction, assignment, or clearance condition ceased to be satisfied',
    explanation: 'Access is allowed because the active credential and every applicable purpose, permission, protection, jurisdiction, assignment, and clearance condition are satisfied.',
  },
});

/**
 * Reason codes only this module can produce. The model is never permitted to
 * emit them, so they cannot be forged into an escalation by the model itself
 * and they never appear as a training label.
 */
const SYSTEM_REASON_CODES = Object.freeze([
  'MODEL_POLICY_DISAGREEMENT', 'MODEL_INPUT_DISAGREEMENT',
]);

const MODEL_REASON_CODES = Object.freeze(
  Object.keys(REASON_DECISION).filter((code) => !SYSTEM_REASON_CODES.includes(code))
);

/**
 * The operation and purpose the policy is evaluated against.
 *
 * These are CANONICAL REQUEST INPUTS: the requester commits them with the
 * request, the chaincode validates them against the policy vocabulary before
 * any inference happens, and they are inside the committed context hash. The
 * deterministic evaluation therefore never consumes the model's reading of the
 * request. They are authoritative for what was ASKED, not for what the
 * requester truly intends — purpose remains a requester assertion.
 */
function canonicalRequest(trusted) {
  const context = trusted.requestContext || {};
  return { action: context.action, purpose: context.purpose };
}

function policyEnvironment(trusted, purpose) {
  return {
    purpose,
    emergencyFlag: Boolean(trusted.requestContext.emergencyFlag),
    approvalToken: trusted.requestContext.approvalTokenPresent
      ? 'ledger-approved' : undefined,
  };
}

/**
 * Compare the model's proposal against a policy result computed from canonical
 * request facts and governed state alone.
 *
 * Two independent conditions must both hold for the model's result to stand:
 *
 *   input agreement  - the model read the same operation and purpose that the
 *                      requester committed. Checked first, because a policy
 *                      comparison against a misread request is meaningless.
 *   policy agreement - the deterministic engine, run on the canonical inputs,
 *                      reaches the identical decision and reason code.
 *
 * Either failure yields ESCALATE. Neither can substitute a different allow or
 * deny for the model's proposal.
 */
function deriveEffectiveClassification(advisory, trusted) {
  const canonical = canonicalRequest(trusted);
  const policyResult = evaluate(
    trusted.subject,
    trusted.record,
    canonical.action,
    policyEnvironment(trusted, canonical.purpose)
  );
  const modelInputAgreement = advisory.action === canonical.action
    && advisory.purpose === canonical.purpose;
  const modelPolicyAgreement = REASON_DECISION[advisory.reasonCode] === advisory.decision
    && advisory.decision === policyResult.decision
    && advisory.reasonCode === policyResult.reasonCode;

  let effective = advisory;
  if (!modelInputAgreement) {
    effective = { ...advisory, decision: 'escalate', reasonCode: 'MODEL_INPUT_DISAGREEMENT' };
  } else if (!modelPolicyAgreement) {
    effective = { ...advisory, decision: 'escalate', reasonCode: 'MODEL_POLICY_DISAGREEMENT' };
  }
  return {
    effective, modelInputAgreement, modelPolicyAgreement, policyResult, canonical,
  };
}

function materializeDecision(classification, trusted) {
  const details = REASON_DETAILS[classification.reasonCode];
  if (!details) throw new Error('cannot explain an unknown policy reason');
  const canonical = canonicalRequest(trusted);
  // Use the deployed policy engine's own evidence when it produced this reason.
  // A system-generated reason uses its fixed controlled evidence rather than
  // pretending the model supplied it.
  const policyResult = SYSTEM_REASON_CODES.includes(classification.reasonCode)
    ? null
    : evaluate(
      trusted.subject,
      trusted.record,
      canonical.action,
      policyEnvironment(trusted, canonical.purpose)
    );
  const policyEvidence = policyResult && policyResult.reasonCode === classification.reasonCode
    ? policyResult
    : null;
  return {
    decision: REASON_DECISION[classification.reasonCode],
    reasonCode: classification.reasonCode,
    // The request as COMMITTED, never as the model read it. What the model read
    // is retained verbatim in the signed inference descriptor instead.
    parsedRequest: {
      action: canonical.action,
      purpose: canonical.purpose,
      recordId: trusted.record.recordId,
      recordType: trusted.record.recordType,
      caseId: trusted.record.caseId,
      emergencyFlag: Boolean(trusted.requestContext.emergencyFlag),
    },
    decisiveAttributes: policyEvidence
      ? [...policyEvidence.decisiveAttributes]
      : [...details.decisiveAttributes],
    counterfactual: policyEvidence
      ? policyEvidence.counterfactual
      : details.counterfactual(trusted, classification),
    explanation: details.explanation,
    policyVersion: classification.policyVersion,
    modelVersion: classification.modelVersion,
  };
}

module.exports = {
  MODEL_REASON_CODES,
  SYSTEM_REASON_CODES,
  REASON_DECISION,
  REASON_DETAILS,
  canonicalRequest,
  deriveEffectiveClassification,
  materializeDecision,
};
