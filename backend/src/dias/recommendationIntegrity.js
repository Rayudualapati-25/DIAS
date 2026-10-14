'use strict';

/** Does the stored recommendation object M match its ledger commitment κ?. */

const { recommendationHashOf } = require('./recommendationObject');

const BOUND_FIELDS = Object.freeze([
  'contextHash', 'claimsHash', 'justificationHash', 'policyVersion', 'policyHash', 'modelVersion',
]);

function checkRecommendationIntegrity({ commitment, recommendationObject }) {
  if (!commitment) return { status: 'no-commitment', problems: [], recommendationHash: null };
  if (!recommendationObject) {
    return {
      status: 'missing-object',
      problems: ['the off-chain recommendation object is not available'],
      recommendationHash: null,
    };
  }
  const problems = [];
  let digest = null;
  try {
    digest = recommendationHashOf(recommendationObject);
  } catch (_error) {
    problems.push('the stored object cannot be put in canonical form');
  }
  if (digest !== commitment.recommendationHash) {
    problems.push('h_M of the stored object differs from the committed recommendationHash');
  }
  if (recommendationObject.recommendation !== commitment.recommendation) {
    problems.push('recommendation differs from the commitment');
  }
  if (recommendationObject.generationStatus !== commitment.generationStatus) {
    problems.push('generation status differs from the commitment');
  }
  if (recommendationObject.requestId !== commitment.requestId) {
    problems.push('request differs from the commitment');
  }
  const provenance = recommendationObject.provenance || {};
  for (const field of BOUND_FIELDS) {
    if (provenance[field] !== commitment[field]) problems.push(`${field} differs from the commitment`);
  }
  return { status: problems.length === 0 ? 'verified' : 'mismatch', problems, recommendationHash: digest };
}

module.exports = { checkRecommendationIntegrity };
