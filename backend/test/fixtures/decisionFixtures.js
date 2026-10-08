'use strict';

/**
 * Shared fixtures for the auditor-decision tests: a committed request, and a
 * recommendation object M with the commitment κ the ledger holds for it, built
 * the way the backend builds them.
 */

const { verifiedRequestFixture } = require('./diasFixtures');
const { hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');
const { verifiedRequestHash } = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const {
  buildRecommendationObject, modelVersionOf, recommendationHashOf,
} = require('../../src/dias/recommendationObject');

const requester = Object.freeze({ org: 'police', fabricUser: 'insp.test', username: 'insp.test' });
const auditor = Object.freeze({ org: 'audit', fabricUser: 'sp.north', username: 'sp.north' });

function committedRequest(requestId = 'REQ-1') {
  const verifiedRequest = verifiedRequestFixture();
  return {
    requestId,
    recordId: 'FIR-1',
    status: 'awaiting-auditor',
    processingPath: 'auditor-review',
    requester: { username: 'insp.test', stableUserId: 'PoliceMSP::insp.test' },
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
    requesterClaims: { emergencyDeclared: false },
    requesterClaimsHash: '2'.repeat(64),
    justificationHash: hashText('justification', 'Reviewing the FIR.'),
    policyVersion: 'dias-governance-policy-v1',
    policyHash: '9c66ce9ec8954dd0a976db933336aa05dd45acd683abf56f8a65472a4d298c81',
  };
}

function recommendation(value) {
  return {
    generationStatus: 'OK', recommendation: value, reasonCode: value === 'ALLOW' ? 'POLICY_SATISFIED' : 'NOT_ASSIGNED',
    reason: 'text', policyRefs: [], missingEvidence: [], reviewFlags: [], errorCode: null, provenance: {},
  };
}

const MODEL = Object.freeze({
  modelId: 'm', modelFamily: 'qwen3', baseModel: 'mlx-community/Qwen3-14B-4bit', baseModelRevision: 'rev',
  quantization: '4bit', adapterId: null, adapterHash: null, servedModel: 'default_model',
});

/**
 * A recommendation object M and the commitment κ the ledger holds for it, built
 * the way the backend builds them (generationStatus not OK when
 * `value` is null).
 */
function commitmentPair(requestId, value, generationStatus = value ? 'OK' : 'UNAVAILABLE') {
  const request = committedRequest(requestId);
  const binding = {
    contextHash: request.verifiedRequestHash, claimsHash: request.requesterClaimsHash,
    justificationHash: request.justificationHash, policyVersion: request.policyVersion,
    policyHash: request.policyHash,
  };
  const result = value
    ? { generationStatus, recommendation: { recommendation: value, reason_code: 'X', reason: 'r', policy_refs: [], missing_evidence: [], review_flags: [] }, provenance: {} }
    : { generationStatus, recommendation: null, provenance: { errorCode: 'server_unreachable' } };
  const recommendationObject = buildRecommendationObject({ requestId, result, binding, model: MODEL });
  const commitment = {
    commitmentId: `KAPPA-${requestId}`, requestId, ...binding,
    recommendation: recommendationObject.recommendation, generationStatus,
    modelVersion: modelVersionOf(MODEL), recommendationHash: recommendationHashOf(recommendationObject),
  };
  return { recommendationObject, commitment, record: recommendation(value || 'ALLOW') };
}

module.exports = {
  MODEL, auditor, commitmentPair, committedRequest, recommendation, requester,
};
