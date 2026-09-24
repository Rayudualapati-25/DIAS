'use strict';

/**
 * Evaluate the retained SEAL-era V6 adapter on the DIAS v2 test facts.
 *
 * V6 is a HISTORICAL REFERENCE, not a peer. It was trained against a different
 * contract, and three differences matter enough that a raw side-by-side number
 * would mislead:
 *
 *  1. V6's vocabulary has three classes. `escalate` has no binary equivalent, so
 *     it is mapped to "no recommendation" — the same way a generation failure is
 *     treated — rather than being folded into DENY. Folding it into DENY would
 *     flatter V6 on exactly the safety metric that matters.
 *
 *  2. V6 is NOT shown the action and purpose. The SEAL design withheld them so
 *     the model's inference could be compared against them. It therefore has to
 *     read them out of the request text, while V7 is given them as verified
 *     facts. This is a real disadvantage for V6 on this task and is the reason
 *     the comparison is reported as a reference rather than a fair head-to-head.
 *
 *  3. V6's prompt shows a SEAL-era subject/record shape, so the facts are
 *     re-projected into it. Every policy-relevant value is preserved; only the
 *     container changes.
 *
 * All three adaptations are recorded in the output so a reader can see exactly
 * what was compared.
 */

const {
  RULES_SYSTEM_PROMPT, buildUserPrompt,
} = require('../../../../backend/src/llm/policyPrompt');

const ADAPTATIONS = Object.freeze([
  'V6 emits allow/deny/escalate; escalate is mapped to NO RECOMMENDATION '
  + '(status ESCALATE_NOT_IN_BINARY_CONTRACT), never to DENY.',
  'V6 is not shown action or purpose — the SEAL prompt withheld them by design — '
  + 'so it must infer them from the request text while V7 receives them as facts.',
  'Verified-request facts are re-projected into the SEAL subject/record shape; '
  + 'every policy-relevant value is preserved.',
  'V6 receives the SEAL prompt, not the DIAS v2 prompt: asking it with a prompt '
  + 'it was never trained on would measure prompt mismatch, not the model.',
]);

/** The SEAL subject block, from a DIAS verified request. */
function sealSubject(verifiedRequest) {
  const r = verifiedRequest.requester;
  return {
    mspId: r.mspId,
    organization: r.organization,
    role: r.role,
    rank: r.rank,
    station: r.station,
    jurisdiction: r.jurisdiction,
    clearance: r.clearance,
    credentialStatus: r.credentialStatus,
    assignedToRequestedCase: r.assignedToRequestedCase,
  };
}

/** The SEAL record block. */
function sealRecord(verifiedRequest) {
  const r = verifiedRequest.resource;
  return {
    recordType: r.recordType,
    caseId: r.caseId,
    sensitivityLevel: r.sensitivityLevel,
    jurisdiction: r.jurisdiction,
    owningAgency: r.owningAgency,
    owningStation: r.owningStation,
    sealed: r.sealed,
    juvenileFlag: r.juvenileFlag,
    witnessFlag: r.witnessFlag,
    victimProtectionFlag: r.victimProtectionFlag,
  };
}

/** The SEAL prompt for one v2 example. Action and purpose are withheld by design. */
function v6Messages(example) {
  return [
    { role: 'system', content: RULES_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserPrompt({
        query: example.justification,
        subject: sealSubject(example.verifiedRequest),
        record: sealRecord(example.verifiedRequest),
        requestContext: {
          action: example.verifiedRequest.request.action,
          purpose: example.verifiedRequest.request.purpose,
          emergencyFlag: example.verifiedRequest.request.emergencyFlag,
          approvalTokenPresent: example.verifiedRequest.request.approvalTokenPresent,
        },
      }),
    },
  ];
}

const CODE_MAP = Object.freeze({
  CRED_NOT_ACTIVE: 'CRED_NOT_ACTIVE',
  INVALID_PURPOSE: 'INVALID_PURPOSE',
  RBAC_NO_PERMISSION: 'RBAC_NO_PERMISSION',
  SEALED_RECORD: 'SEALED_RECORD',
  JUVENILE_PROTECTED: 'JUVENILE_PROTECTED',
  VICTIM_DATA_NOT_NECESSARY: 'VICTIM_DATA_NOT_NECESSARY',
  CROSS_JURISDICTION: 'CROSS_JURISDICTION',
  NOT_ASSIGNED: 'NOT_ASSIGNED',
  INSUFFICIENT_CLEARANCE: 'INSUFFICIENT_CLEARANCE',
  POLICY_SATISFIED: 'POLICY_SATISFIED',
});

/**
 * Parse a V6 answer into the binary shape, or into an explicit absence.
 * Returns `{ recommendation, status, sealDecision, inferredAction, inferredPurpose }`.
 */
function parseV6(raw) {
  let body = String(raw ?? '').trim();
  if (body.startsWith('<think>')) body = body.split('</think>', 2).pop().trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { recommendation: null, status: 'INVALID_OUTPUT', sealDecision: null };
  }
  const decision = String(parsed.decision || '').toLowerCase();
  const base = {
    sealDecision: decision || null,
    inferredAction: parsed.action ?? null,
    inferredPurpose: parsed.purpose ?? null,
    sealReasonCode: parsed.reasonCode ?? null,
  };
  if (decision === 'escalate') {
    // Deliberately NOT a DENY. The binary contract has no third class, and
    // counting it as DENY would credit V6 with a safe answer it did not give.
    return { ...base, recommendation: null, status: 'ESCALATE_NOT_IN_BINARY_CONTRACT' };
  }
  if (decision !== 'allow' && decision !== 'deny') {
    return { ...base, recommendation: null, status: 'INVALID_OUTPUT' };
  }
  const code = CODE_MAP[parsed.reasonCode];
  if (!code) return { ...base, recommendation: null, status: 'INVALID_OUTPUT' };
  return {
    ...base,
    status: 'OK',
    recommendation: {
      recommendation: decision === 'allow' ? 'ALLOW' : 'DENY',
      reason_code: code,
      // V6 emits no free-text reason, clause references, evidence list or review
      // flags. Those fields are left empty rather than fabricated, so joint and
      // policy-reference metrics are correctly zero for V6 and the report says why.
      reason: '',
      policy_refs: [],
      missing_evidence: [],
      review_flags: [],
    },
  };
}

module.exports = { ADAPTATIONS, CODE_MAP, parseV6, sealRecord, sealSubject, v6Messages };
