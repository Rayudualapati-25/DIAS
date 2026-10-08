'use strict';

/**
 * OFFLINE REFERENCE ORACLE — NOT PART OF THE DIAS RUNTIME.
 *
 * Applies the canonical governance policy bundle deterministically to one
 * synthetic request so that datasets, test fixtures, and offline evaluation have
 * a reproducible reference recommendation. The live DIAS workflow never calls
 * this module: Qwen recommends, the auditor decides, and no runtime code compares
 * the two with this oracle (enforced by the architecture guard tests).
 */

const { clauseRef, findClause } = require('../lib/bundle');

const SEAL_CLAUSE = 'GP-SEAL:C1';
const SEALED_REVIEW_FLAG = 'SEALED_RECORD_COURT_REVIEW';

const rankIn = (order, value) => (order.includes(value) ? order.indexOf(value) : null);
const withoutVersion = (ref) => ref.split('@')[0];

const DENY_PREDICATES = Object.freeze({
  'GP-CRED:C1': ({ requester }) => requester.credentialStatus !== 'active',
  'GP-PURPOSE:C1': ({ request }, bundle) => !bundle.vocabularies.purposes.includes(request.purpose),
  'GP-RBAC:C1': ({ requester }, bundle) => {
    const role = bundle.roles[requester.role];
    return !role || bundle.vocabularies.organizationsByMsp[requester.mspId] !== role.organization;
  },
  'GP-RBAC:C2': ({ requester, resource, request }, bundle) => {
    const permitted = (bundle.rbac[requester.role] || {})[request.action] || [];
    return !permitted.includes(resource.recordType);
  },
  'GP-SEAL:C1': ({ requester, resource }) => resource.sealed === true
    && requester.mspId !== 'CourtMSP',
  'GP-JUV:C1': ({ requester, resource }, bundle) => resource.juvenileFlag === true
    && !bundle.roleLists.juvenileAuthorized.includes(requester.role),
  'GP-VICTIM:C1': ({ requester, resource }, bundle) => resource.victimProtectionFlag === true
    && bundle.roleLists.victimDataBlocked.includes(requester.role),
  'GP-JURIS:C1': ({ requester, resource }) => requester.jurisdiction !== resource.jurisdiction,
  'GP-ASSIGN:C1': ({ requester }, bundle) => requester.assignedToRequestedCase !== true
    && !bundle.roleLists.assignmentExempt.includes(requester.role),
  'GP-CLEAR:C1': ({ requester, resource }, bundle) => {
    const { clearanceOrder, unknownSensitivityTreatedAs } = bundle.vocabularies;
    const needed = rankIn(clearanceOrder, resource.sensitivityLevel)
      ?? clearanceOrder.indexOf(unknownSensitivityTreatedAs);
    const held = rankIn(clearanceOrder, requester.clearance) ?? -1;
    return held < needed;
  },
});

const REQUIRED_FACTS = Object.freeze({
  requester: ['mspId', 'role', 'jurisdiction', 'clearance', 'credentialStatus', 'assignedToRequestedCase'],
  resource: ['recordType', 'caseId', 'sensitivityLevel', 'jurisdiction', 'sealed', 'juvenileFlag', 'victimProtectionFlag'],
  request: ['action', 'purpose'],
});

function assertFacts(facts) {
  for (const [group, fields] of Object.entries(REQUIRED_FACTS)) {
    if (!facts || !facts[group] || typeof facts[group] !== 'object') {
      throw new Error(`reference oracle: facts.${group} is required`);
    }
    const missing = fields.filter((field) => !(field in facts[group]));
    if (missing.length > 0) {
      throw new Error(`reference oracle: facts.${group} is missing ${missing.join(', ')}`);
    }
  }
}

function assertCoverage(bundle) {
  const uncovered = bundle.precedence.denyOrder
    .filter((ref) => !DENY_PREDICATES[withoutVersion(ref)]);
  if (uncovered.length > 0) {
    throw new Error(`reference oracle has no predicate for ${uncovered.join(', ')}`);
  }
}

/** Reference recommendation for one request under the given bundle. */
function evaluateReference(bundle, facts) {
  assertCoverage(bundle);
  assertFacts(facts);
  const applicable = bundle.precedence.denyOrder
    .filter((ref) => DENY_PREDICATES[withoutVersion(ref)](facts, bundle));
  const reviewFlags = applicable.some((ref) => withoutVersion(ref) === SEAL_CLAUSE)
    ? [SEALED_REVIEW_FLAG] : [];
  if (applicable.length === 0) {
    const defaultClause = findClause(bundle, bundle.precedence.defaultClause);
    return Object.freeze({
      recommendation: 'ALLOW',
      reason_code: defaultClause.reasonCode,
      policy_refs: [...bundle.precedence.allowPolicyRefs],
      applicable_deny_clauses: [],
      decisive_clause: bundle.precedence.defaultClause,
      review_flags: reviewFlags,
    });
  }
  return Object.freeze({
    recommendation: 'DENY',
    reason_code: findClause(bundle, applicable[0]).reasonCode,
    policy_refs: [...applicable],
    applicable_deny_clauses: [...applicable],
    decisive_clause: applicable[0],
    review_flags: reviewFlags,
  });
}

const REASON_TEMPLATES = Object.freeze({
  'GP-CRED:C1': ({ requester }) => `Requester credential status is ${requester.credentialStatus}, not active`,
  'GP-PURPOSE:C1': ({ request }) => `Purpose ${request.purpose} is not an allowed purpose`,
  'GP-RBAC:C1': ({ requester }, bundle) => {
    const role = bundle.roles[requester.role];
    return role
      ? `Role ${requester.role} belongs to ${role.organization}, not to requester organization ${requester.mspId}`
      : `Role ${requester.role} is not defined in the policy`;
  },
  'GP-RBAC:C2': ({ requester, resource, request }) => `Role ${requester.role} may not ${request.action} ${resource.recordType} records`,
  'GP-SEAL:C1': () => 'The record is sealed and the requester is outside the court organization',
  'GP-JUV:C1': ({ requester }) => `The record is juvenile-protected and role ${requester.role} is not juvenile-authorized`,
  'GP-VICTIM:C1': ({ requester }) => `The record is victim-protected and role ${requester.role} is barred from victim-protected data`,
  'GP-JURIS:C1': ({ requester, resource }) => `Requester jurisdiction ${requester.jurisdiction} differs from record jurisdiction ${resource.jurisdiction}`,
  'GP-ASSIGN:C1': ({ requester, resource }) => `Role ${requester.role} is not assignment-exempt and the requester is not assigned to case ${resource.caseId}`,
  'GP-CLEAR:C1': ({ requester, resource }) => `Requester clearance ${requester.clearance} is below record sensitivity ${resource.sensitivityLevel}`,
});

/** Concise, fact-based reference explanation matching a reference result. */
function referenceReason(bundle, facts, result) {
  if (result.recommendation === 'ALLOW') {
    const { requester, resource, request } = facts;
    return `Role ${requester.role} may ${request.action} ${resource.recordType} records and no DENY clause applies (${result.policy_refs.join(', ')}).`;
  }
  const [decisive, ...others] = result.applicable_deny_clauses;
  const sentence = `${REASON_TEMPLATES[withoutVersion(decisive)](facts, bundle)} (${decisive}).`;
  return others.length === 0 ? sentence : `${sentence} Also applicable: ${others.join(', ')}.`;
}

module.exports = {
  DENY_PREDICATES,
  REQUIRED_FACTS,
  SEALED_REVIEW_FLAG,
  clauseRef,
  evaluateReference,
  referenceReason,
};
