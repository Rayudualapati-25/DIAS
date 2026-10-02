'use strict';

/**
 * The recommendation service (design §2, §6.1).
 *
 * It receives a committed request's verified context, claims and justification
 * together with the digests and policy the ledger recorded for them. Before
 * judging anything it recomputes those digests and checks that the policy it
 * holds is the request's policy. Then it runs the recommender, builds the
 * recommendation object M, and signs the commitment κ with its own key.
 *
 * When the inputs do not match their digests, or the policy differs, it does not
 * judge: it signs a specific failure status instead, so the ledger records that
 * no recommendation could be produced and why. A signature therefore attests
 * "this service produced this exact M for this request under this policy"; it
 * does not attest that the recommendation is correct.
 *
 * This module has no Fabric identity and never talks to the ledger.
 */

const { verifiedRequestHash } = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { requesterClaimsHash } = require('../../../chaincode/crimerecords/lib/dias/requesterClaims');
const { DOMAINS, hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');
const { provenancePayload } = require('../../../chaincode/crimerecords/lib/dias/recommendationCommitment');
const {
  buildRecommendationObject, modelVersionOf, recommendationHashOf,
} = require('../dias/recommendationObject');

/** Which input does not match its committed digest, or null when all match. */
function digestMismatch(input) {
  const checks = [
    ['verified_request_hash_mismatch', () => verifiedRequestHash(input.verifiedRequest) === input.verifiedRequestHash],
    ['requester_claims_hash_mismatch', () => requesterClaimsHash(input.requesterClaims) === input.requesterClaimsHash],
    ['justification_hash_mismatch',
      () => hashText(DOMAINS.JUSTIFICATION, String(input.justification ?? '')) === input.justificationHash],
  ];
  for (const [code, matches] of checks) {
    try {
      if (!matches()) return code;
    } catch (_error) {
      return code;
    }
  }
  return null;
}

function createRecommendationService({ recommender, signer, channel, policy, model }) {
  if (!recommender || !signer || !channel || !policy || !model) {
    throw new Error('recommendation service requires a recommender, a signer, a channel, a policy and a model');
  }

  async function judge(input) {
    const failure = (generationStatus, errorCode, errorDetail) => recommender.unavailable({
      requestId: input.requestId,
      verifiedRequestHash: input.verifiedRequestHash,
      requesterClaimsHash: input.requesterClaimsHash,
      justificationHash: input.justificationHash,
      generationStatus,
      errorCode,
      errorDetail,
    });
    const mismatch = digestMismatch(input);
    if (mismatch) {
      return failure('UNAVAILABLE', mismatch, 'an input does not match its committed digest');
    }
    if (input.policyVersion !== policy.policyVersion || input.policyHash !== policy.policyHash) {
      return failure('POLICY_CONTEXT_UNAVAILABLE', 'policy_version_mismatch',
        `the request is bound to ${input.policyVersion}; this service holds ${policy.policyVersion}`);
    }
    return recommender.recommend({
      requestId: input.requestId,
      verifiedRequest: input.verifiedRequest,
      requesterClaims: input.requesterClaims,
      justification: input.justification,
    });
  }

  async function recommend(input) {
    const result = await judge(input);
    const binding = {
      contextHash: input.verifiedRequestHash,
      claimsHash: input.requesterClaimsHash,
      justificationHash: input.justificationHash,
      policyVersion: input.policyVersion,
      policyHash: input.policyHash,
    };
    const recommendationObject = buildRecommendationObject({
      requestId: input.requestId, result, binding, model,
    });
    const recommendationHash = recommendationHashOf(recommendationObject);
    const fields = {
      ...binding,
      recommendation: recommendationObject.recommendation,
      generationStatus: recommendationObject.generationStatus,
      modelVersion: modelVersionOf(model),
      recommendationHash,
      signerKeyId: signer.keyId,
    };
    const signature = signer.sign(provenancePayload({ channel, requestId: input.requestId, ...fields }));
    return {
      recommendationObject,
      recommendationHash,
      commitment: { ...fields, signature },
      result,
    };
  }

  return Object.freeze({ recommend, keyId: signer.keyId, publicKeyPem: signer.publicKeyPem });
}

module.exports = { createRecommendationService };
