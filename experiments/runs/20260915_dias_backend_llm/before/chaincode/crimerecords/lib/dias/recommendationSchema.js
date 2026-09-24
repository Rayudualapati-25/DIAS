'use strict';

/**
 * DIAS recommendation response contract v1.
 *
 * Structural validation only: keys, types, vocabulary, and internal consistency
 * with the registered policy bundle's reason codes, clause references, and review
 * flags. It never compares a recommendation with the verified facts; the auditor
 * is the authority on whether a recommendation is right.
 */

const RESPONSE_SCHEMA_VERSION = 'dias-recommendation-response-v1';
const RESPONSE_KEYS = Object.freeze([
  'recommendation', 'reason_code', 'reason', 'policy_refs', 'missing_evidence', 'review_flags',
]);
const RECOMMENDATIONS = Object.freeze(['ALLOW', 'DENY']);

/** Generation outcomes. Only OK carries a recommendation. */
const GENERATION_STATUS = Object.freeze({
  OK: 'OK',
  UNAVAILABLE: 'UNAVAILABLE',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  POLICY_CONTEXT_UNAVAILABLE: 'POLICY_CONTEXT_UNAVAILABLE',
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
});
const FAILURE_STATUSES = Object.freeze(
  Object.values(GENERATION_STATUS).filter((status) => status !== GENERATION_STATUS.OK)
);

const LIMITS = Object.freeze({
  reason: 600,
  policyRefs: 12,
  missingEvidence: 5,
  missingEvidenceItem: 200,
  reviewFlags: 5,
});

function isStringList(value, maxItems, maxLength) {
  return Array.isArray(value) && value.length <= maxItems
    && value.every((item) => typeof item === 'string' && item.trim().length > 0
      && item.length <= maxLength);
}

function listProblems(field, value, allowed, maxItems) {
  if (!isStringList(value, maxItems, 128)) return [`${field} must be a list of at most ${maxItems} strings`];
  const unknown = value.filter((item) => !allowed.includes(item));
  const problems = unknown.length > 0 ? [`${field} contains undefined entries: ${unknown.join(', ')}`] : [];
  return new Set(value).size === value.length ? problems : [...problems, `${field} contains duplicates`];
}

/**
 * Problems with a model response under a registered policy bundle; empty means valid.
 * @param {object} policy { clauseRefs: string[], reasonCodes: {code: 'ALLOW'|'DENY'}, reviewFlags: string[] }
 */
function validateRecommendationOutput(value, policy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['response must be a JSON object'];
  }
  const problems = [];
  if (Object.keys(value).sort().join(',') !== [...RESPONSE_KEYS].sort().join(',')) {
    problems.push(`response must contain exactly ${RESPONSE_KEYS.join(', ')}`);
  }
  if (!RECOMMENDATIONS.includes(value.recommendation)) {
    problems.push('recommendation must be ALLOW or DENY');
  }
  if (!Object.prototype.hasOwnProperty.call(policy.reasonCodes, value.reason_code)) {
    problems.push('reason_code is not defined by the policy');
  } else if (RECOMMENDATIONS.includes(value.recommendation)
      && policy.reasonCodes[value.reason_code] !== value.recommendation) {
    problems.push('reason_code does not belong to the recommendation');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0
      || value.reason.length > LIMITS.reason) {
    problems.push(`reason must be a non-empty string of at most ${LIMITS.reason} characters`);
  }
  if (!Array.isArray(value.policy_refs)) {
    problems.push(`policy_refs must be a list of at most ${LIMITS.policyRefs} strings`);
  } else if (value.policy_refs.length === 0) {
    problems.push('policy_refs must list at least one clause reference');
  } else {
    problems.push(...listProblems('policy_refs', value.policy_refs, policy.clauseRefs, LIMITS.policyRefs));
  }
  if (!isStringList(value.missing_evidence, LIMITS.missingEvidence, LIMITS.missingEvidenceItem)) {
    problems.push(`missing_evidence must be a list of at most ${LIMITS.missingEvidence} short strings`);
  }
  problems.push(...listProblems('review_flags', value.review_flags, policy.reviewFlags, LIMITS.reviewFlags));
  return problems;
}

/** A valid response in canonical key order. */
function normalizeRecommendation(value) {
  return Object.fromEntries(RESPONSE_KEYS.map((key) => [key, value[key]]));
}

module.exports = {
  FAILURE_STATUSES,
  GENERATION_STATUS,
  LIMITS,
  RECOMMENDATIONS,
  RESPONSE_KEYS,
  RESPONSE_SCHEMA_VERSION,
  normalizeRecommendation,
  validateRecommendationOutput,
};
