'use strict';

/**
 * Shared fixtures for the signed-recommender tests: a model identity, the policy
 * the backend holds, an Ed25519 signer, a committed request's inputs with their
 * ledger digests, and a recommender that records its calls.
 */

const crypto = require('crypto');
const { createRecommendationSigner } = require('../../src/dias/recommendationSigner');
const {
  provenancePayload, verifyProvenance,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationCommitment');
const { verifiedRequestHash } = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { requesterClaimsHash } = require('../../../chaincode/crimerecords/lib/dias/requesterClaims');
const { hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');
const { policyIdentity } = require('../../src/dias/policyRegistration');
const { requesterClaimsFixture, validOutput, verifiedRequestFixture } = require('./diasFixtures');

const MODEL = Object.freeze({
  modelId: 'qwen3-14b-dias-v7', modelFamily: 'qwen3', baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4', quantization: '4bit',
  adapterId: null, adapterHash: null, servedModel: 'default_model',
});
const POLICY = policyIdentity();

function newSigner() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return createRecommendationSigner({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
}

function input(overrides = {}) {
  const verifiedRequest = verifiedRequestFixture();
  const requesterClaims = requesterClaimsFixture();
  const justification = 'Reviewing the FIR for the open investigation.';
  return {
    requestId: 'REQ-1',
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
    requesterClaims,
    requesterClaimsHash: requesterClaimsHash(requesterClaims),
    justification,
    justificationHash: hashText('justification', justification),
    policyVersion: POLICY.policyVersion,
    policyHash: POLICY.policyHash,
    ...overrides,
  };
}

function fakeRecommender(outcome) {
  const calls = [];
  return {
    calls,
    recommend: async (args) => { calls.push(args); return outcome; },
    unavailable: ({ generationStatus, errorCode, errorDetail }) => ({
      generationStatus, recommendation: null, provenance: { errorCode, errorDetail, latencyMs: { total: 0 } },
    }),
  };
}

const ok = (recommendation = 'DENY') => ({
  generationStatus: 'OK',
  recommendation: validOutput({ recommendation, reason_code: recommendation === 'DENY' ? 'NOT_ASSIGNED' : 'POLICY_SATISFIED' }),
  provenance: { promptVersion: 'dias-recommendation-prompt-v2', latencyMs: { total: 5 } },
});

function verifies(signer, requestId, commitment) {
  const { signature, ...fields } = commitment;
  return verifyProvenance({
    publicKeyPem: signer.publicKeyPem,
    payload: provenancePayload({ channel: 'diaschannel', requestId, ...fields }),
    signature,
  });
}

module.exports = {
  MODEL, POLICY, fakeRecommender, input, newSigner, ok, verifies,
};
