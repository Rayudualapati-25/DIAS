'use strict';

/**
 * The backend recommendation path: off-chain review store, LLM agreement, and
 * the worker that answers requests one at a time and resumes after a restart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const { createReviewStore } = require('../src/dias/reviewStore');
const { createRecommendationWorker, recommendationRecord } = require('../src/dias/recommendationWorker');
const {
  LLM_AGREEMENT, createsAuthorization, llmAgreementFor, requiresAuditorReason,
} = require('../src/dias/agreement');
const { verifiedRequestHash } = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { validOutput, verifiedRequestFixture } = require('./fixtures/diasFixtures');

const silent = Object.freeze({ log: () => {}, error: () => {} });

function committed(requestId, overrides = {}) {
  const verifiedRequest = verifiedRequestFixture();
  return {
    requestId,
    recordId: 'FIR-1',
    requester: { username: 'insp.test' },
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
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

  describe('recommendation worker', () => {
    it('stores a schema-valid recommendation in the auditor-facing shape', async () => {
      store.create({ request: committed('REQ-3'), justification: 'Reviewing the FIR.' });
      const asked = [];
      const recommender = {
        recommend: async (input) => {
          asked.push(input);
          return okResult(validOutput({ recommendation: 'DENY', reason_code: 'NOT_ASSIGNED', policy_refs: ['GP-ASSIGN:C1@v1'] }));
        },
        unavailable: () => failureResult('unused'),
      };
      const worker = createRecommendationWorker({ store, recommender, log: silent });
      await worker.enqueue('REQ-3');
      expect(asked[0]).to.include({ requestId: 'REQ-3', justification: 'Reviewing the FIR.' });
      const entry = store.read('REQ-3');
      expect(entry.recommendationState).to.equal('ready');
      expect(entry.recommendation).to.include({
        generationStatus: 'OK', recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED', errorCode: null,
      });
      expect(entry.recommendation.policyRefs).to.deep.equal(['GP-ASSIGN:C1@v1']);
    });

    it('stores a failed generation as a status with no recommendation', () => {
      const record = recommendationRecord(failureResult('server_unreachable'));
      expect(record).to.include({
        generationStatus: 'UNAVAILABLE', recommendation: null, reasonCode: null, errorCode: 'server_unreachable',
      });
    });

    it('never prompts the LLM with facts that do not match the committed hash', async () => {
      store.create({ request: committed('REQ-4', { verifiedRequestHash: '0'.repeat(64) }), justification: 'why' });
      let prompted = false;
      const recommender = {
        recommend: async () => {
          prompted = true;
          return okResult();
        },
        unavailable: (input) => ({ ...failureResult(input.errorCode) }),
      };
      await createRecommendationWorker({ store, recommender, log: silent }).enqueue('REQ-4');
      expect(prompted).to.equal(false);
      expect(store.read('REQ-4').recommendation.errorCode).to.equal('verified_request_hash_mismatch');
    });

    it('records an unexpected error instead of leaving the auditor waiting', async () => {
      store.create({ request: committed('REQ-5'), justification: 'why' });
      const recommender = {
        recommend: async () => { throw new Error('boom'); },
        unavailable: (input) => ({ ...failureResult(input.errorCode) }),
      };
      await createRecommendationWorker({ store, recommender, log: silent }).enqueue('REQ-5');
      expect(store.read('REQ-5')).to.include({ recommendationState: 'ready' });
      expect(store.read('REQ-5').recommendation.errorCode).to.equal('recommendation_failed');
    });

    it('answers requests one at a time, each once, and resumes pending entries', async () => {
      for (const id of ['REQ-6', 'REQ-7']) store.create({ request: committed(id), justification: 'why' });
      store.create({ request: committed('REQ-8'), justification: 'why' });
      store.update('REQ-8', { recommendationState: 'ready', recommendation: recommendationRecord(okResult()) });
      let running = 0;
      let maxRunning = 0;
      const order = [];
      const recommender = {
        recommend: async ({ requestId }) => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          order.push(requestId);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return okResult();
        },
        unavailable: () => failureResult('unused'),
      };
      const worker = createRecommendationWorker({ store, recommender, log: silent });
      expect(worker.resumePending()).to.equal(2);
      worker.enqueue('REQ-6');
      await worker.idle();
      expect(maxRunning).to.equal(1);
      expect(order.sort()).to.deep.equal(['REQ-6', 'REQ-7']);
      expect(store.list().every((entry) => entry.recommendationState === 'ready')).to.equal(true);
    });
  });
});
