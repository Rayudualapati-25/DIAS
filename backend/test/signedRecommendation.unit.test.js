'use strict';

/**
 * The signed recommender, the part of the backend that asks the model and signs
 * what it got (design §6.1): it recomputes the digests of what it is asked to
 * judge, checks its policy is the request's policy, runs the recommender, builds
 * M, and signs κ. A mismatch is not judged; it is signed as a specific failure
 * status, so the ledger still records that it happened.
 */

const crypto = require('crypto');
const { expect } = require('chai');
const { createRecommendationSigner } = require('../src/dias/recommendationSigner');
const { createSignedRecommender } = require('../src/dias/signedRecommendation');
const { recommendationHashOf } = require('../src/dias/recommendationObject');
const {
  provenancePayload, signerKeyIdOf, verifyProvenance,
} = require('../../chaincode/crimerecords/lib/dias/recommendationCommitment');
const { requesterClaimsFixture, verifiedRequestFixture } = require('./fixtures/diasFixtures');
const {
  MODEL, POLICY, fakeRecommender, input, newSigner, ok, verifies,
} = require('./fixtures/signedRecommendationFixtures');

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

describe('signed recommender', () => {
  const make = (recommender, signer = newSigner()) => ({
    signer,
    signedRecommender: createSignedRecommender({
      recommender, signer, channel: 'diaschannel', policy: POLICY, model: MODEL,
    }),
  });

  it('signs a commitment bound to the request, its digests and h_M', async () => {
    const recommender = fakeRecommender(ok('DENY'));
    const { signer, signedRecommender } = make(recommender);
    const produced = await signedRecommender.recommend(input());
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
    const { signer, signedRecommender } = make(recommender);
    const produced = await signedRecommender.recommend(input({ justification: 'changed after commit' }));
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
      const { signedRecommender } = make(recommender);
      const produced = await signedRecommender.recommend(input(overrides));
      expect(recommender.calls, code).to.have.length(0);
      expect(produced.commitment).to.include({ generationStatus: 'UNAVAILABLE', recommendation: null });
      expect(produced.recommendationObject.error.code).to.equal(code);
    }
  });

  it('does not judge under another policy, and signs that as POLICY_CONTEXT_UNAVAILABLE', async () => {
    const recommender = fakeRecommender(ok());
    const { signedRecommender } = make(recommender);
    const produced = await signedRecommender.recommend(input({ policyVersion: 'dias-governance-policy-v2', policyHash: 'e'.repeat(64) }));
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
    const { signedRecommender } = make(recommender);
    const { commitment } = await signedRecommender.recommend(input());
    expect(commitment).to.include({ generationStatus: 'CONTEXT_OVERFLOW', recommendation: null });
  });

  it('produces the identical commitment again for the same model output (safe retry)', async () => {
    const signer = newSigner();
    const first = await make(fakeRecommender(ok('ALLOW')), signer).signedRecommender.recommend(input());
    const second = await make(fakeRecommender(ok('ALLOW')), signer).signedRecommender.recommend(input());
    expect(second.commitment).to.deep.equal(first.commitment);
  });
});
