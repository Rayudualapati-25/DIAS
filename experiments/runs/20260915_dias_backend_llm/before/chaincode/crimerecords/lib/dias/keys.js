'use strict';

/** Ledger key types and collection names shared by the DIAS contracts. */
module.exports = Object.freeze({
  REQUEST: 'diasAccessRequest',
  RECOMMENDATION: 'diasLlmRecommendation',
  AUDITOR_DECISION: 'diasAuditorDecision',
  OUTCOME: 'diasAccessOutcome',
  ACCESS_DECISION: 'accessDecision',
  RECORD: 'record',
  USER: 'user',
  CASE: 'case',
  POLICY_BUNDLE: 'governancePolicyBundle',
  ACTIVE_POLICY_BUNDLE: 'activeGovernancePolicyBundle',
  MODEL_REGISTRATION: 'recommendationModel',
  ACTIVE_MODEL: 'activeRecommendationModel',
  PRIVATE_COLLECTION: 'accessRequestQuery',
  AI_DECIDER_MSP: 'AIOrgMSP',
  AI_DECIDER_ROLE: 'llm-decider',
});
