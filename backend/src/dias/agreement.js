'use strict';

/**
 * The LLM recommendation an auditor decision was taken against, and whether the decision agreed with it.
 */

const LLM_AGREEMENT = Object.freeze({
  AGREED: 'AGREED',
  NOT_AGREED: 'NOT_AGREED',
  NO_RECOMMENDATION: 'NO_RECOMMENDATION',
});

/** What the ledger records as the recommendation. Every failure is UNAVAILABLE. */
const LLM_RECOMMENDATION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  UNAVAILABLE: 'UNAVAILABLE',
});

const AUDITOR_DECISIONS = Object.freeze(['FORCE_ALLOW', 'FORCE_DENY']);

function hasRecommendation(recommendation) {
  return Boolean(recommendation)
    && recommendation.generationStatus === 'OK'
    && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
}

/** The recommendation value committed on the ledger. */
function llmRecommendationFor(recommendation) {
  return hasRecommendation(recommendation)
    ? recommendation.recommendation : LLM_RECOMMENDATION.UNAVAILABLE;
}

function llmAgreementFor(recommendation, decision) {
  if (!AUDITOR_DECISIONS.includes(decision)) {
    throw new Error('auditor decision must be one of [FORCE_ALLOW, FORCE_DENY]');
  }
  if (!hasRecommendation(recommendation)) return LLM_AGREEMENT.NO_RECOMMENDATION;
  const auditorAllows = decision === 'FORCE_ALLOW';
  const llmAllows = recommendation.recommendation === 'ALLOW';
  return auditorAllows === llmAllows ? LLM_AGREEMENT.AGREED : LLM_AGREEMENT.NOT_AGREED;
}

/** The auditor explains every decision that is not simple agreement with the LLM. */
function requiresAuditorReason(llmAgreement) {
  return llmAgreement !== LLM_AGREEMENT.AGREED;
}

/** Exactly one combination creates a dynamic authorization. */
function createsAuthorization(decision, llmAgreement) {
  return decision === 'FORCE_ALLOW' && llmAgreement === LLM_AGREEMENT.NOT_AGREED;
}

module.exports = {
  AUDITOR_DECISIONS,
  LLM_AGREEMENT,
  LLM_RECOMMENDATION,
  createsAuthorization,
  hasRecommendation,
  llmAgreementFor,
  llmRecommendationFor,
  requiresAuditorReason,
};
