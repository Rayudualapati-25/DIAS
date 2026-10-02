'use strict';

/**
 * The recommendation service core (design §6.1): it recomputes the digests of
 * what it is asked to judge, checks its policy is the request's policy, runs the
 * recommender, builds M, and signs κ. A mismatch is not judged; it is signed as a
 * specific failure status, so the ledger still records that it happened.
 */

const crypto = require('crypto');
const { expect } = require('chai');
const { createRecommendationSigner } = require('../src/dias/recommendationSigner');
const { createRecommendationService } = require('../src/recommender-service/service');
const { recommendationHashOf } = require('../src/dias/recommendationObject');
const {
  provenancePayload, signerKeyIdOf, verifyProvenance,
} = require('../../chaincode/crimerecords/lib/dias/recommendationCommitment');
const { verifiedRequestHash } = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { requesterClaimsHash } = require('../../chaincode/crimerecords/lib/dias/requesterClaims');
const { hashText } = require('../../chaincode/crimerecords/lib/dias/commitments');
const { policyIdentity } = require('../src/dias/policyRegistration');
const {
  requesterClaimsFixture, validOutput, verifiedRequestFixture,
} = require('./fixtures/diasFixtures');

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

describe('recommendation signer', () => {
  it('signs provenance with an Ed25519 key whose identifier is the public-key digest', () => {
    const signer = newSigner();
    expect(signer.keyId).to.equal(signerKeyIdOf(signer.publicKeyPem));
    const payload = provenancePayload({
      channel: 'diaschannel', requestId: 'REQ-1', contextHash: '1'.repeat(64), claimsHash: '2'.repeat(64),
      justificationHash: '3'.repeat(64), policyVersion: POLICY.policyVersion, policyHash: POLICY.policyHash,
      recommendation: 'ALLOW', generationStatus: 'OK', modelVersion: 'm@r', recommendationHash: '5'.repeat(64),
      signerKeyId: signer.keyId,
    });
    expect(verifyProvenance({ publicKeyPem: signer.publicKeyPem, payload, signature: signer.sign(payload) }))
      .to.equal(true);
  });

  it('refuses a key that is not Ed25519', () => {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => createRecommendationSigner({ privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) }))
      .to.throw(/must be an Ed25519 private key/);
  });
});

describe('recommendation service', () => {
  const make = (recommender, signer = newSigner()) => ({
    signer,
    service: createRecommendationService({ recommender, signer, channel: 'diaschannel', policy: POLICY, model: MODEL }),
  });

  it('signs a commitment bound to the request, its digests and h_M', async () => {
    const recommender = fakeRecommender(ok('DENY'));
    const { signer, service } = make(recommender);
    const produced = await service.recommend(input());
    const { commitment, recommendationObject } = produced;
    expect(recommender.calls).to.have.length(1);
    expect(commitment).to.include({
      contextHash: input().verifiedRequestHash, claimsHash: input().requesterClaimsHash,
      justificationHash: input().justificationHash, policyVersion: POLICY.policyVersion,
      policyHash: POLICY.policyHash, recommendation: 'DENY', generationStatus: 'OK', signerKeyId: signer.keyId,
      recommendationHash: recommendationHashOf(recommendationObject),
    });
    expect(verifies(signer, 'REQ-1', commitment)).to.equal(true);
    expect(verifies(signer, 'REQ-2', commitment)).to.equal(false);
  });

  it('does not judge inputs whose digests do not match, and signs that as UNAVAILABLE', async () => {
    const recommender = fakeRecommender(ok());
    const { signer, service } = make(recommender);
    const produced = await service.recommend(input({ justification: 'changed after commit' }));
    expect(recommender.calls).to.have.length(0);
    expect(produced.commitment).to.include({
      generationStatus: 'UNAVAILABLE', recommendation: null, justificationHash: input().justificationHash,
    });
    expect(produced.recommendationObject.error.code).to.equal('justification_hash_mismatch');
    expect(verifies(signer, 'REQ-1', produced.commitment)).to.equal(true);
  });

  // Moved from the v2 worker tests: facts or claims that no longer match the
  // digests the ledger holds are never shown to the model.
  it('does not judge a changed verified context or changed claims, naming which one', async () => {
    const facts = verifiedRequestFixture();
    const changedFacts = { ...facts, request: { ...facts.request, purpose: 'audit' } };
    const changedClaims = { ...requesterClaimsFixture(), emergencyDeclared: !requesterClaimsFixture().emergencyDeclared };
    for (const [overrides, code] of [
      [{ verifiedRequest: changedFacts }, 'verified_request_hash_mismatch'],
      [{ requesterClaims: changedClaims }, 'requester_claims_hash_mismatch'],
    ]) {
      const recommender = fakeRecommender(ok());
      const { service } = make(recommender);
      const produced = await service.recommend(input(overrides));
      expect(recommender.calls, code).to.have.length(0);
      expect(produced.commitment).to.include({ generationStatus: 'UNAVAILABLE', recommendation: null });
      expect(produced.recommendationObject.error.code).to.equal(code);
    }
  });

  it('does not judge under another policy, and signs that as POLICY_CONTEXT_UNAVAILABLE', async () => {
    const recommender = fakeRecommender(ok());
    const { service } = make(recommender);
    const produced = await service.recommend(input({ policyVersion: 'dias-governance-policy-v2', policyHash: 'e'.repeat(64) }));
    expect(recommender.calls).to.have.length(0);
    expect(produced.commitment).to.include({
      generationStatus: 'POLICY_CONTEXT_UNAVAILABLE', policyHash: 'e'.repeat(64),
    });
    expect(produced.recommendationObject.error.code).to.equal('policy_version_mismatch');
  });

  it('keeps the specific failure status the recommender reports', async () => {
    const recommender = fakeRecommender({
      generationStatus: 'CONTEXT_OVERFLOW', recommendation: null,
      provenance: { errorCode: 'prompt_exceeds_budget', latencyMs: { total: 1 } },
    });
    const { service } = make(recommender);
    const { commitment } = await service.recommend(input());
    expect(commitment).to.include({ generationStatus: 'CONTEXT_OVERFLOW', recommendation: null });
  });

  it('produces the identical commitment again for the same model output (safe retry)', async () => {
    const signer = newSigner();
    const first = await make(fakeRecommender(ok('ALLOW')), signer).service.recommend(input());
    const second = await make(fakeRecommender(ok('ALLOW')), signer).service.recommend(input());
    expect(second.commitment).to.deep.equal(first.commitment);
  });
});
