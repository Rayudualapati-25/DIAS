'use strict';

/**
 * Whether an auditor decision agreed with the LLM recommendation shown for it.
 *
 * The backend derives this from the stored recommendation; the browser never
 * supplies it. The value is committed on the ledger with the decision, and it is
 * what lets the chaincode create a dynamic authorization only for an auditor
 * FORCE_ALLOW that did not agree with an LLM DENY.
 */

const LLM_AGREEMENT = Object.freeze({
  AGREED: 'AGREED',
  NOT_AGREED: 'NOT_AGREED',
  NO_RECOMMENDATION: 'NO_RECOMMENDATION',
});

const AUDITOR_DECISIONS = Object.freeze(['FORCE_ALLOW', 'FORCE_DENY']);

function hasRecommendation(recommendation) {
  return Boolean(recommendation)
    && recommendation.generationStatus === 'OK'
    && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
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
  createsAuthorization,
  hasRecommendation,
  llmAgreementFor,
  requiresAuditorReason,
};
