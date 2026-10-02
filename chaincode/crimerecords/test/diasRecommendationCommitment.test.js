'use strict';

/**
 * Plan steps 10 and 12 (contract side): the pre-review recommendation commitment
 * κ and its signed provenance (design §6), and the agreement the decision now
 * derives from κ instead of from a value the backend supplies (paper Eq. 3).
 */

const crypto = require('crypto');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld, createSigner } = require('./diasTestWorld');
const { hashText } = require('../lib/dias/commitments');

const INSPECTOR = CALLERS.inspector;
const FAILURES = ['UNAVAILABLE', 'INVALID_OUTPUT', 'POLICY_CONTEXT_UNAVAILABLE', 'CONTEXT_OVERFLOW'];

describe('DIAS pre-review recommendation commitment (plan steps 10 and 12)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  async function pending(options) {
    const { result } = await world.submit(INSPECTOR, options);
    return result;
  }

  const stateSize = () => world.ledger._state.size;

  describe('signer registry', () => {
    it('registers an Ed25519 key under the digest of its public key', async () => {
      const der = crypto.createPublicKey(world.signer.publicKeyPem).export({ type: 'spki', format: 'der' });
      expect(world.signerKeyId).to.equal(crypto.createHash('sha256').update(der).digest('hex'));
      const signers = (await world.run(INSPECTOR, world.nextTx('Q'),
        (ctx) => world.contracts.governance.QueryRecommendationSigners(ctx))).result;
      expect(signers).to.have.length(1);
      expect(signers[0]).to.include({ keyId: world.signerKeyId, status: 'active', algorithm: 'Ed25519' });
    });

    it('refuses duplicates, other key types, malformed keys and non-auditors', async () => {
      await expect(world.registerSigner(world.signer.publicKeyPem)).to.be.rejectedWith(/already registered/);
      const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey
        .export({ type: 'spki', format: 'pem' });
      await expect(world.registerSigner(ec)).to.be.rejectedWith(/must be an Ed25519 public key/);
      await expect(world.registerSigner('not a key')).to.be.rejectedWith(/must be an Ed25519 public key/);
      await expect(world.registerSigner(createSigner().publicKeyPem, { caller: INSPECTOR }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
    });

    it('stops accepting commitments signed by a revoked key, and revocation needs a reason', async () => {
      const request = await pending();
      const revoke = (reason) => world.run(CALLERS.auditor, world.nextTx('REVK'), (ctx) => world.contracts
        .governance.RevokeRecommendationSigner(ctx, world.signerKeyId, reason));
      await expect(revoke('')).to.be.rejectedWith(/a revocation reason is required/);
      await revoke('Key rotated.');
      await expect(world.commit(request.requestId, world.commitmentFor(request.requestId)))
        .to.be.rejectedWith(/DIAS_SIGNER_INACTIVE/);
    });
  });

  describe('acceptance', () => {
    it('commits a signed recommendation before review, bound to the request', async () => {
      const request = await pending();
      const input = world.commitmentFor(request.requestId, { recommendation: 'DENY' });
      const { result } = await world.commit(request.requestId, input);
      expect(result).to.include({
        requestId: request.requestId, recommendation: 'DENY', generationStatus: 'OK',
        contextHash: request.verifiedRequestHash, policyHash: request.policyHash,
        recommendationHash: input.recommendationHash, signerKeyId: world.signerKeyId,
        schemaVersion: 'dias-recommendation-commitment-v1',
      });
      expect(result.commitmentId).to.match(/^KAPPA-/);
      expect(world.readRequest(request.requestId).recommendationCommitmentId).to.equal(result.commitmentId);
      expect(world.eventTypes(request.requestId)).to.include('RECOMMENDATION_COMMITTED');
    });

    it('treats an identical resubmission as a safe retry that writes nothing', async () => {
      const request = await pending();
      const input = world.commitmentFor(request.requestId);
      const { result: first } = await world.commit(request.requestId, input);
      const before = stateSize();
      const { result: again } = await world.commit(request.requestId, input);
      expect(again).to.deep.equal(first);
      expect(stateSize()).to.equal(before);
    });

    it('rejects a different commitment for the same request without writing', async () => {
      const request = await pending();
      await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'ALLOW' }));
      const before = stateSize();
      await expect(world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' })))
        .to.be.rejectedWith(/DIAS_COMMITMENT_CONFLICT/);
      expect(stateSize()).to.equal(before);
      expect(world.readState('diasRecommendationCommitment', request.requestId).recommendation).to.equal('ALLOW');
    });

    it('keeps every specific generation failure status', async () => {
      for (const status of FAILURES) {
        const request = await pending({ recordId: 'FIR-2', justification: `failure ${status}` });
        const { result } = await world.commit(request.requestId,
          world.commitmentFor(request.requestId, { recommendation: null, generationStatus: status }));
        expect(result).to.include({ generationStatus: status, recommendation: null });
        await world.cancel(request.requestId);
      }
    });
  });

  describe('rejection', () => {
    it('rejects commitments whose bindings do not match the request', async () => {
      const request = await pending();
      for (const field of ['contextHash', 'claimsHash', 'justificationHash', 'policyHash']) {
        const input = world.commitmentFor(request.requestId, { signedOverrides: { [field]: 'f'.repeat(64) } });
        await expect(world.commit(request.requestId, input), field)
          .to.be.rejectedWith(new RegExp(`DIAS_COMMITMENT_MISMATCH: ${field}`));
      }
      expect(world.readState('diasRecommendationCommitment', request.requestId)).to.equal(null);
    });

    it('rejects inconsistent or malformed content', async () => {
      const request = await pending();
      const cases = [
        [{ recommendation: null, generationStatus: 'OK' }, /OK requires a recommendation/],
        [{ recommendation: 'ALLOW', generationStatus: 'UNAVAILABLE' }, /only an OK generation carries a recommendation/],
        [{ recommendation: 'ESCALATE', generationStatus: 'OK' }, /recommendation must be ALLOW, DENY or null/],
        [{ recommendation: null, generationStatus: 'ERROR' }, /generationStatus must be one of/],
        [{ recommendationHash: 'XYZ' }, /recommendationHash must be a SHA-256 digest/],
        [{ modelVersion: 'bad model version!' }, /modelVersion has invalid format/],
      ];
      for (const [fields, error] of cases) {
        const input = { ...world.commitmentFor(request.requestId), ...fields };
        await expect(world.commit(request.requestId, input), JSON.stringify(fields)).to.be.rejectedWith(error);
      }
      const { signature, ...unsigned } = world.commitmentFor(request.requestId);
      await expect(world.commit(request.requestId, unsigned)).to.be.rejectedWith(/exactly/);
      await expect(world.commit(request.requestId, { ...world.commitmentFor(request.requestId), extra: 1 }))
        .to.be.rejectedWith(/exactly/);
    });

    it('rejects a commitment changed after signing, or signed by an unregistered key', async () => {
      const request = await pending();
      const tampered = { ...world.commitmentFor(request.requestId, { recommendation: 'ALLOW' }), recommendation: 'DENY' };
      await expect(world.commit(request.requestId, tampered)).to.be.rejectedWith(/DIAS_SIGNATURE_INVALID/);
      const stranger = createSigner();
      const forged = world.commitmentFor(request.requestId, { sign: stranger.sign });
      await expect(world.commit(request.requestId, forged)).to.be.rejectedWith(/DIAS_SIGNATURE_INVALID/);
      await expect(world.commit(request.requestId, world.commitmentFor(request.requestId, {
        sign: stranger.sign, signerKeyId: 'a'.repeat(64),
      }))).to.be.rejectedWith(/DIAS_SIGNER_INACTIVE/);
    });

    it('rejects a valid commitment replayed onto another request', async () => {
      const first = await pending({ justification: 'Same words.' });
      const input = world.commitmentFor(first.requestId);
      await world.cancel(first.requestId);
      const second = await pending({ justification: 'Same words.' });
      expect(second.verifiedRequestHash).to.equal(first.verifiedRequestHash);
      await expect(world.commit(second.requestId, input)).to.be.rejectedWith(/DIAS_SIGNATURE_INVALID/);
    });

    it('rejects a commitment after the deadline, a policy change, or a decision', async () => {
      const late = await pending();
      await expect(world.commit(late.requestId, world.commitmentFor(late.requestId),
        { timestamp: '2026-08-08T12:00:01.000Z' })).to.be.rejectedWith(/DIAS_REQUEST_EXPIRED/);
      const decided = await pending({ recordId: 'FIR-2' });
      await world.decide(decided.requestId, 'FORCE_DENY', null);
      await expect(world.commit(decided.requestId, world.commitmentFor(decided.requestId)))
        .to.be.rejectedWith(/is not awaiting-auditor/);
      const stale = await pending({ justification: 'Before the policy change.' });
      const signedEarlier = world.commitmentFor(stale.requestId);
      await world.changePolicy();
      await expect(world.commit(stale.requestId, signedEarlier)).to.be.rejectedWith(/DIAS_STALE_POLICY/);
    });
  });

  describe('agreement derived from the commitment (paper Eq. 3)', () => {
    const table = [
      ['ALLOW', 'FORCE_ALLOW', 'AGREED', false],
      ['ALLOW', 'FORCE_DENY', 'NOT_AGREED', false],
      ['DENY', 'FORCE_ALLOW', 'NOT_AGREED', true],
      ['DENY', 'FORCE_DENY', 'AGREED', false],
    ];
    for (const [recommendation, decision, agreement, creates] of table) {
      it(`${recommendation} + ${decision} -> ${agreement}${creates ? ', authorization created' : ''}`, async () => {
        const request = await pending();
        const { result } = await world.decide(request.requestId, decision, recommendation);
        const kappa = world.readState('diasRecommendationCommitment', request.requestId);
        expect(result.auditorDecision).to.include({
          llmRecommendation: recommendation, generationStatus: 'OK', llmAgreement: agreement,
          recommendationCommitmentId: kappa.commitmentId, recommendationHash: kappa.recommendationHash,
          authorizationCreated: creates,
        });
        expect(Boolean(result.dynamicAuthorization)).to.equal(creates);
        if (creates) {
          expect(result.dynamicAuthorization).to.include({
            recommendationCommitmentId: kappa.commitmentId, recommendationHash: kappa.recommendationHash,
          });
        }
        expect(world.eventTypes(request.requestId)).to.include('AGREEMENT_DERIVED');
      });
    }

    for (const status of FAILURES) {
      it(`a committed ${status} -> NO_RECOMMENDATION with the specific status`, async () => {
        const request = await pending();
        const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'UNAVAILABLE', { generationStatus: status });
        expect(result.auditorDecision).to.include({
          llmRecommendation: 'UNAVAILABLE', generationStatus: status, llmAgreement: 'NO_RECOMMENDATION',
          authorizationCreated: false,
        });
      });
    }

    it('no commitment at all -> NO_RECOMMENDATION recorded as NOT_COMMITTED', async () => {
      const request = await pending();
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', null);
      expect(result.auditorDecision).to.include({
        llmRecommendation: 'UNAVAILABLE', generationStatus: 'NOT_COMMITTED', llmAgreement: 'NO_RECOMMENDATION',
        recommendationCommitmentId: null, authorizationCreated: false,
      });
    });

    it('takes no recommendation from the caller: the third argument is the note digest', async () => {
      expect(world.contracts.access.SubmitAuditorDecision.length).to.equal(5);
      const request = await pending();
      await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' }));
      await expect(world.run(CALLERS.auditor, world.nextTx('OLD'), (ctx) => world.contracts.access
        .SubmitAuditorDecision(ctx, request.requestId, 'FORCE_ALLOW', 'ALLOW', '')))
        .to.be.rejectedWith(/noteHash must be a SHA-256 digest/);
      const note = hashText('note', 'Override: the case lead confirmed the assignment.');
      const { result } = await world.run(CALLERS.auditor, world.nextTx('NEW'), (ctx) => world.contracts.access
        .SubmitAuditorDecision(ctx, request.requestId, 'FORCE_ALLOW', note, ''));
      expect(result.auditorDecision).to.include({ llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED', noteHash: note });
    });
  });
});
