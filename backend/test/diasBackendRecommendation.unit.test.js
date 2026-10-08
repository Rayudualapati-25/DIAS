'use strict';

/**
 * The backend recommendation path: off-chain review store, LLM agreement, and
 * the worker that answers requests one at a time and resumes after a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const { createReviewStore, isRecommendationPreparing } = require('../src/dias/reviewStore');
const { createRecommendationWorker, recommendationRecord } = require('../src/dias/recommendationWorker');
const {
  LLM_AGREEMENT, createsAuthorization, llmAgreementFor, requiresAuditorReason,
} = require('../src/dias/agreement');
const { verifiedRequestHash } = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { requesterClaimsHash } = require('../../chaincode/crimerecords/lib/dias/requesterClaims');
const { hashText } = require('../../chaincode/crimerecords/lib/dias/commitments');
const {
  requesterClaimsFixture, validOutput, verifiedRequestFixture,
} = require('./fixtures/diasFixtures');

const silent = Object.freeze({ log: () => {}, error: () => {} });

function committed(requestId, overrides = {}) {
  const verifiedRequest = verifiedRequestFixture();
  const requesterClaims = requesterClaimsFixture({ emergencyDeclared: true });
  return {
    requestId,
    recordId: 'FIR-1',
    requester: { username: 'insp.test' },
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
    requesterClaims,
    requesterClaimsHash: requesterClaimsHash(requesterClaims),
    justificationHash: hashText('justification', overrides.justificationText || 'why'),
    policyVersion: 'dias-governance-policy-v1',
    policyHash: '9c66ce9ec8954dd0a976db933336aa05dd45acd683abf56f8a65472a4d298c81',
    ...overrides,
  };
}

function okResult(output = validOutput()) {
  return {
    generationStatus: 'OK',
    recommendation: output,
    provenance: { requestId: 'REQ', latencyMs: { total: 12 }, modelId: 'fixture' },
  };
}

function failureResult(errorCode) {
  return {
    generationStatus: 'UNAVAILABLE',
    recommendation: null,
    provenance: { errorCode, latencyMs: { total: 1 } },
  };
}

describe('DIAS backend recommendation path', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-store-'));
    store = createReviewStore(dir, { now: () => new Date('2026-09-15T10:00:00.000Z') });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('LLM agreement', () => {
    const rec = (value) => ({ generationStatus: 'OK', recommendation: value });

    it('is AGREED when the auditor follows the LLM and NOT_AGREED otherwise', () => {
      expect(llmAgreementFor(rec('ALLOW'), 'FORCE_ALLOW')).to.equal(LLM_AGREEMENT.AGREED);
      expect(llmAgreementFor(rec('DENY'), 'FORCE_DENY')).to.equal(LLM_AGREEMENT.AGREED);
      expect(llmAgreementFor(rec('DENY'), 'FORCE_ALLOW')).to.equal(LLM_AGREEMENT.NOT_AGREED);
      expect(llmAgreementFor(rec('ALLOW'), 'FORCE_DENY')).to.equal(LLM_AGREEMENT.NOT_AGREED);
    });

    it('is NO_RECOMMENDATION without a valid recommendation', () => {
      expect(llmAgreementFor(null, 'FORCE_ALLOW')).to.equal(LLM_AGREEMENT.NO_RECOMMENDATION);
      expect(llmAgreementFor({ generationStatus: 'INVALID_OUTPUT', recommendation: null }, 'FORCE_DENY'))
        .to.equal(LLM_AGREEMENT.NO_RECOMMENDATION);
      expect(() => llmAgreementFor(rec('ALLOW'), 'ALLOW')).to.throw(/FORCE_ALLOW, FORCE_DENY/);
    });

    it('requires a reason unless agreed, and creates an authorization only for FORCE_ALLOW over a DENY', () => {
      expect(requiresAuditorReason('AGREED')).to.equal(false);
      expect(requiresAuditorReason('NOT_AGREED')).to.equal(true);
      expect(requiresAuditorReason('NO_RECOMMENDATION')).to.equal(true);
      expect(createsAuthorization('FORCE_ALLOW', 'NOT_AGREED')).to.equal(true);
      expect(createsAuthorization('FORCE_ALLOW', 'AGREED')).to.equal(false);
      expect(createsAuthorization('FORCE_DENY', 'NOT_AGREED')).to.equal(false);
      expect(createsAuthorization('FORCE_ALLOW', 'NO_RECOMMENDATION')).to.equal(false);
    });
  });

  describe('review store', () => {
    it('keeps the justification and a pending recommendation for a committed request', () => {
      const entry = store.create({ request: committed('REQ-1'), justification: 'Reviewing the FIR.' });
      expect(entry).to.include({
        requestId: 'REQ-1', recordId: 'FIR-1', requesterUsername: 'insp.test',
        justification: 'Reviewing the FIR.', recommendationState: 'pending', recommendation: null,
      });
      expect(store.read('REQ-1')).to.deep.equal(entry);
      expect(fs.readdirSync(dir)).to.deep.equal(['REQ-1.json']);
    });

    it('replaces entries without mutating what an earlier read returned', () => {
      const before = store.create({ request: committed('REQ-2'), justification: 'why' });
      const after = store.update('REQ-2', { recommendationState: 'ready' });
      expect(before.recommendationState).to.equal('pending');
      expect(after.recommendationState).to.equal('ready');
      expect(store.list().map((entry) => entry.requestId)).to.deep.equal(['REQ-2']);
    });

    it('counts a recommendation as being prepared until its commitment is confirmed or it has failed', () => {
      const state = (recommendationState) => ({ recommendationState });
      expect(['pending', 'signed'].map((value) => isRecommendationPreparing(state(value)))).to.deep.equal([true, true]);
      expect(['committed', 'commit-rejected', 'failed', 'ready', null]
        .map((value) => isRecommendationPreparing(state(value)))).to.deep.equal([false, false, false, false, false]);
      expect(isRecommendationPreparing(null)).to.equal(false);
    });

    it('rejects unsafe request identifiers and reports missing entries', () => {
      expect(() => store.read('../escape')).to.throw(/invalid format/);
      expect(store.read('REQ-404')).to.equal(null);
      expect(() => store.update('REQ-404', {})).to.throw(/no off-chain review exists/);
    });

    it('skips an unreadable entry when listing, so one damaged file cannot stop the backend', () => {
      const skipped = [];
      const logging = createReviewStore(dir, { log: { error: (message) => skipped.push(message) } });
      logging.create({ request: committed('REQ-9'), justification: 'why' });
      fs.writeFileSync(path.join(dir, 'REQ-10.json'), '{ not json');
      expect(logging.list().map((entry) => entry.requestId)).to.deep.equal(['REQ-9']);
      expect(skipped).to.have.length(1);
      expect(skipped[0]).to.match(/REQ-10\.json/);
    });
  });

  describe('recommendation worker (v3: signed recommender, commitment, ledger)', () => {
    const RELAY = Object.freeze({ org: 'audit', fabricUser: 'sp.north' });

    function signedCommitment(requestId, overrides = {}) {
      return {
        contextHash: '1'.repeat(64), claimsHash: '2'.repeat(64), justificationHash: '3'.repeat(64),
        policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64), recommendation: 'DENY',
        generationStatus: 'OK', modelVersion: 'base@rev', recommendationHash: '5'.repeat(64),
        signerKeyId: '6'.repeat(64), signature: `${'A'.repeat(86)}==`, ...overrides,
      };
    }

    function fakeSignedRecommender(result = okResult(validOutput({ recommendation: 'DENY', reason_code: 'NOT_ASSIGNED' }))) {
      const calls = [];
      return {
        calls,
        recommend: async (input) => {
          calls.push(input);
          return {
            recommendationObject: { requestId: input.requestId, generationStatus: result.generationStatus },
            recommendationHash: '5'.repeat(64),
            commitment: signedCommitment(input.requestId, {
              recommendation: result.recommendation ? result.recommendation.recommendation : null,
              generationStatus: result.generationStatus,
            }),
            result,
          };
        },
      };
    }

    function fakeLedger({ submitError = null, onLedger = null } = {}) {
      const calls = [];
      let failures = submitError ? 1 : 0;
      return {
        calls,
        submit: async (org, user, contract, fn, requestId, json) => {
          calls.push([org, user, contract, fn, requestId]);
          if (failures > 0) { failures -= 1; throw submitError; }
          return { commitmentId: `KAPPA-${requestId}`, txId: `tx-${requestId}`, ...JSON.parse(json) };
        },
        evaluate: async (org, user, contract, fn) => {
          calls.push([org, user, contract, fn]);
          return typeof onLedger === 'function' ? onLedger() : onLedger;
        },
      };
    }

    const worker = (signedRecommender, ledger) => createRecommendationWorker({
      store, signedRecommender, ledger, relay: RELAY, log: silent,
    });

    it('asks the signed recommender, stores M and the signed commitment, then commits it before review', async () => {
      store.create({ request: committed('REQ-3'), justification: 'why' });
      const signedRecommender = fakeSignedRecommender();
      const ledger = fakeLedger();
      await worker(signedRecommender, ledger).enqueue('REQ-3');
      const entry = store.read('REQ-3');
      expect(entry).to.include({ recommendationState: 'committed', commitmentId: 'KAPPA-REQ-3' });
      expect(entry.commitment.recommendation).to.equal('DENY');
      expect(entry.recommendationObject).to.include({ requestId: 'REQ-3' });
      expect(entry.recommendation).to.include({ generationStatus: 'OK', recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED' });
      expect(ledger.calls[0]).to.deep.equal(['audit', 'sp.north', 'AccessContract', 'CommitRecommendation', 'REQ-3']);
    });

    it('gives the signed recommender the committed inputs and the digests the ledger holds for them', async () => {
      store.create({ request: committed('REQ-7', { justificationText: 'Reviewing the FIR.', policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64) }), justification: 'Reviewing the FIR.' });
      const signedRecommender = fakeSignedRecommender();
      await worker(signedRecommender, fakeLedger()).enqueue('REQ-7');
      const [input] = signedRecommender.calls;
      expect(input).to.include({
        requestId: 'REQ-7', justification: 'Reviewing the FIR.',
        justificationHash: hashText('justification', 'Reviewing the FIR.'),
        policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64),
      });
      expect(input.verifiedRequest).to.deep.equal(verifiedRequestFixture());
      expect(input.requesterClaims).to.deep.equal({ emergencyDeclared: true });
      expect(input.verifiedRequestHash).to.equal(verifiedRequestHash(verifiedRequestFixture()));
    });

    it('keeps a specific failure status in the auditor view and still commits it', async () => {
      store.create({ request: committed('REQ-4'), justification: 'why' });
      const ledger = fakeLedger();
      await worker(fakeSignedRecommender(failureResult('server_unreachable')), ledger).enqueue('REQ-4');
      const entry = store.read('REQ-4');
      expect(entry.recommendationState).to.equal('committed');
      expect(entry.recommendation).to.include({
        generationStatus: 'UNAVAILABLE', recommendation: null, errorCode: 'server_unreachable',
      });
      expect(entry.commitment).to.include({ generationStatus: 'UNAVAILABLE', recommendation: null });
    });

    it('marks a commitment the ledger refuses for a lasting reason as commit-rejected', async () => {
      store.create({ request: committed('REQ-9'), justification: 'why' });
      const expired = Object.assign(new Error('endorse failed'), {
        details: [{ message: 'DIAS_REQUEST_EXPIRED: the review deadline has passed' }],
      });
      await worker(fakeSignedRecommender(), fakeLedger({ submitError: expired })).enqueue('REQ-9');
      expect(store.read('REQ-9')).to.include({
        recommendationState: 'commit-rejected', commitError: 'DIAS_REQUEST_EXPIRED: the review deadline has passed',
      });
    });

    it('keeps a signed commitment after an uncertain failure and later resubmits it unchanged', async () => {
      store.create({ request: committed('REQ-10'), justification: 'why' });
      const signedRecommender = fakeSignedRecommender();
      const timeout = new Error('commit status deadline exceeded');
      await worker(signedRecommender, fakeLedger({ submitError: timeout, onLedger: null })).enqueue('REQ-10');
      const signed = store.read('REQ-10');
      expect(signed.recommendationState).to.equal('signed');
      const retried = worker(signedRecommender, fakeLedger());
      expect(retried.resumePending()).to.equal(1);
      await retried.idle();
      const entry = store.read('REQ-10');
      expect(entry.recommendationState).to.equal('committed');
      expect(entry.commitment).to.deep.equal(signed.commitment);
      expect(signedRecommender.calls).to.have.length(1);
    });

    it('recognizes a commitment that reached the ledger although the response was lost', async () => {
      store.create({ request: committed('REQ-11'), justification: 'why' });
      const timeout = new Error('commit status deadline exceeded');
      const ledger = fakeLedger({
        submitError: timeout,
        onLedger: () => ({ commitmentId: 'KAPPA-REQ-11', txId: 'tx-11', ...store.read('REQ-11').commitment }),
      });
      await worker(fakeSignedRecommender(), ledger).enqueue('REQ-11');
      expect(store.read('REQ-11')).to.include({ recommendationState: 'committed', commitmentId: 'KAPPA-REQ-11' });
    });

    it('records a recommender failure as failed, so the auditor is not left waiting', async () => {
      store.create({ request: committed('REQ-5'), justification: 'why' });
      const broken = { recommend: async () => { throw new Error('signing key unavailable'); } };
      await worker(broken, fakeLedger()).enqueue('REQ-5');
      const entry = store.read('REQ-5');
      expect(entry.recommendationState).to.equal('failed');
      expect(entry.recommendation).to.include({ generationStatus: 'UNAVAILABLE', errorCode: 'recommendation_failed' });
    });

    it('answers requests one at a time, each once, and resumes pending and signed entries', async () => {
      for (const id of ['REQ-6', 'REQ-7']) store.create({ request: committed(id), justification: 'why' });
      store.create({ request: committed('REQ-8'), justification: 'why' });
      store.update('REQ-8', { recommendationState: 'committed' });
      let running = 0;
      let maxRunning = 0;
      const order = [];
      const signedRecommender = fakeSignedRecommender();
      const slow = {
        recommend: async (input) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          order.push(input.requestId);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return signedRecommender.recommend(input);
        },
      };
      const queue = worker(slow, fakeLedger());
      expect(queue.resumePending()).to.equal(2);
      queue.enqueue('REQ-6');
      await queue.idle();
      expect(maxRunning).to.equal(1);
      expect(order.sort()).to.deep.equal(['REQ-6', 'REQ-7']);
      expect(store.list().every((entry) => entry.recommendationState === 'committed')).to.equal(true);
    });

    it('stores a failed generation as a status with no recommendation', () => {
      const record = recommendationRecord(failureResult('server_unreachable'));
      expect(record).to.include({
        generationStatus: 'UNAVAILABLE', recommendation: null, reasonCode: null, errorCode: 'server_unreachable',
      });
    });
  });
});
