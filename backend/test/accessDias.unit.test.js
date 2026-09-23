'use strict';

/**
 * DIAS access routes: request submission and the auditor decision.
 *
 * The LLM runs in this backend and its recommendation stays off-chain. What the
 * routes must get right is what reaches the ledger: the request without the
 * justification, and the auditor decision with an LLM agreement the backend
 * derived itself from the stored recommendation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const accessRouter = require('../src/routes/access');
const { createReviewStore } = require('../src/dias/reviewStore');
const { verifiedRequestFixture } = require('./fixtures/diasFixtures');

const requester = Object.freeze({ org: 'police', fabricUser: 'insp.test', username: 'insp.test' });
const auditor = Object.freeze({ org: 'audit', fabricUser: 'sp.north', username: 'sp.north' });

function committedRequest(requestId = 'REQ-1') {
  const verifiedRequest = verifiedRequestFixture();
  const { verifiedRequestHash } = require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
  return {
    requestId,
    recordId: 'FIR-1',
    status: 'awaiting-auditor',
    processingPath: 'auditor-review',
    requester: { username: 'insp.test', stableUserId: 'PoliceMSP::insp.test' },
    verifiedRequest,
    verifiedRequestHash: verifiedRequestHash(verifiedRequest),
  };
}

function recommendation(value) {
  return {
    generationStatus: 'OK', recommendation: value, reasonCode: value === 'ALLOW' ? 'POLICY_SATISFIED' : 'NOT_ASSIGNED',
    reason: 'text', policyRefs: [], missingEvidence: [], reviewFlags: [], errorCode: null, provenance: {},
  };
}

function ledgerRecording() {
  const calls = [];
  return {
    calls,
    submit: async (...args) => {
      calls.push(args);
      return {
        auditorDecision: { decidedAtUtc: '2026-09-15T10:00:00.000Z', txId: 'tx-1', llmAgreement: args[6] },
        accessOutcome: { outcome: args[5] === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED' },
        dynamicAuthorization: null,
      };
    },
  };
}

describe('DIAS access routes', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-reviews-'));
    store = createReviewStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function storedReview(requestId, fields = {}) {
    store.create({ request: committedRequest(requestId), justification: 'Reviewing the FIR.' });
    return Object.keys(fields).length > 0 ? store.update(requestId, fields) : store.read(requestId);
  }

  describe('request submission', () => {
    it('commits the request with no justification and no transient data', async () => {
      let captured;
      const ledger = {
        submit: async (...args) => {
          captured = args;
          return { requestId: 'REQ-3' };
        },
      };
      await accessRouter.submitAccessRequest(
        requester, ['FIR-1', '{"action":"view","purpose":"investigation","emergencyFlag":false}'], { ledger }
      );
      expect(captured.slice(0, 4)).to.deep.equal(['police', 'insp.test', 'AccessContract', 'CreateAccessRequest']);
      expect(captured).to.have.length(6);
      expect(captured.join(' ')).to.not.match(/justification/i);
    });

    it('retries only the pre-submit peer-convergence mismatch', async () => {
      let attempts = 0;
      const sleeps = [];
      const ledger = {
        submit: async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('ProposalResponsePayloads do not match');
          return { requestId: 'REQ-2', status: 'awaiting-auditor' };
        },
      };
      const result = await accessRouter.submitAccessRequest(
        requester, ['FIR-1', '{}'],
        { ledger, sleep: async (milliseconds) => sleeps.push(milliseconds), retries: 3 }
      );
      expect(result.requestId).to.equal('REQ-2');
      expect(attempts).to.equal(3);
      expect(sleeps).to.deep.equal([150, 300]);
    });

    it('does not retry unrelated Fabric failures', async () => {
      let attempts = 0;
      const ledger = {
        submit: async () => {
          attempts += 1;
          throw new Error('authorization failed');
        },
      };
      let caught;
      try {
        await accessRouter.submitAccessRequest(requester, ['FIR-1', '{}'], { ledger, sleep: async () => {}, retries: 3 });
      } catch (error) {
        caught = error;
      }
      expect(caught.message).to.equal('authorization failed');
      expect(attempts).to.equal(1);
    });

    it('queues the LLM recommendation once the off-chain review is saved', () => {
      const queued = [];
      const opened = accessRouter.openReview({
        request: committedRequest('REQ-6'), justification: 'Reviewing the FIR.',
        store, worker: { enqueue: (id) => queued.push(id) }, log: { error: () => {} },
      });
      expect(opened.recommendationState).to.equal('pending');
      expect(queued).to.deep.equal(['REQ-6']);
      expect(store.read('REQ-6').justification).to.equal('Reviewing the FIR.');
    });

    it('still answers for a committed request when its off-chain review cannot be saved', () => {
      const errors = [];
      const queued = [];
      const opened = accessRouter.openReview({
        request: committedRequest('REQ-7'), justification: 'why',
        store: { create: () => { throw new Error('disk full'); } },
        worker: { enqueue: (id) => queued.push(id) },
        log: { error: (message) => errors.push(message) },
      });
      expect(opened.recommendationState).to.equal('not-generated');
      expect(opened.message).to.match(/on the ledger.*without an LLM recommendation/);
      expect(queued).to.deep.equal([]);
      expect(errors[0]).to.match(/REQ-7.*disk full/);
    });

    it('requires a justification between 3 and 2000 characters', () => {
      const base = { recordId: 'FIR-1', action: 'view', purpose: 'investigation' };
      expect(accessRouter.requestSchema.safeParse({ ...base, justification: 'ok' }).success).to.equal(false);
      expect(accessRouter.requestSchema.safeParse({ ...base, justification: 'x'.repeat(2001) }).success).to.equal(false);
      expect(accessRouter.requestSchema.safeParse({ ...base, justification: 'Reviewing the FIR.' }).success).to.equal(true);
    });
  });

  describe('auditor review view', () => {
    it('joins the committed request with the off-chain justification and recommendation', () => {
      const entry = storedReview('REQ-4', { recommendationState: 'ready', recommendation: recommendation('DENY') });
      const view = accessRouter.reviewView(committedRequest('REQ-4'), entry);
      expect(view).to.include({ justification: 'Reviewing the FIR.', recommendationState: 'ready' });
      expect(view.recommendation).to.include({ recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED' });
      expect(accessRouter.reviewView(committedRequest('REQ-5'), null))
        .to.include({ justification: null, recommendationState: 'not-generated', recommendation: null });
    });
  });

  describe('auditor decision', () => {
    const decideWith = (requestId, body, ledger) => accessRouter.decide({
      user: auditor, requestId, body, ledger, store,
    });

    it('commits AGREED when the auditor follows the LLM, without requiring a reason', async () => {
      storedReview('REQ-10', { recommendationState: 'ready', recommendation: recommendation('ALLOW') });
      const ledger = ledgerRecording();
      const outcome = await decideWith('REQ-10', { decision: 'FORCE_ALLOW' }, ledger);
      expect(outcome).to.include({ status: 201, llmAgreement: 'AGREED' });
      expect(ledger.calls[0]).to.deep.equal([
        'audit', 'sp.north', 'AccessContract', 'SubmitAuditorDecision', 'REQ-10', 'FORCE_ALLOW', 'AGREED', '',
      ]);
      expect(store.read('REQ-10').auditorNote).to.include({
        decision: 'FORCE_ALLOW', llmAgreement: 'AGREED', reason: null, auditorUsername: 'sp.north', txId: 'tx-1',
      });
    });

    it('commits NOT_AGREED for FORCE_ALLOW over an LLM DENY, with a reason and optional expiry', async () => {
      storedReview('REQ-11', { recommendationState: 'ready', recommendation: recommendation('DENY') });
      const ledger = ledgerRecording();
      const missingReason = await decideWith('REQ-11', { decision: 'FORCE_ALLOW' }, ledger);
      expect(missingReason.status).to.equal(400);
      expect(missingReason.error).to.match(/reason is required/);
      const outcome = await decideWith('REQ-11', {
        decision: 'FORCE_ALLOW', reason: 'Verified supervisor tasking.', validUntilUtc: '2026-12-01T00:00:00Z',
      }, ledger);
      expect(outcome).to.include({ status: 201, llmAgreement: 'NOT_AGREED' });
      expect(ledger.calls).to.have.length(1);
      expect(ledger.calls[0].slice(4)).to.deep.equal(['REQ-11', 'FORCE_ALLOW', 'NOT_AGREED', '2026-12-01T00:00:00Z']);
      expect(store.read('REQ-11').auditorNote.reason).to.equal('Verified supervisor tasking.');
    });

    it('commits NOT_AGREED for FORCE_DENY over an LLM ALLOW and refuses an expiry there', async () => {
      storedReview('REQ-12', { recommendationState: 'ready', recommendation: recommendation('ALLOW') });
      const ledger = ledgerRecording();
      const withExpiry = await decideWith('REQ-12', {
        decision: 'FORCE_DENY', reason: 'Restricted inquiry.', validUntilUtc: '2026-12-01T00:00:00Z',
      }, ledger);
      expect(withExpiry.status).to.equal(400);
      expect(withExpiry.error).to.match(/applies only when a dynamic authorization is created/);
      const outcome = await decideWith('REQ-12', { decision: 'FORCE_DENY', reason: 'Restricted inquiry.' }, ledger);
      expect(outcome.llmAgreement).to.equal('NOT_AGREED');
      expect(ledger.calls[0][6]).to.equal('NOT_AGREED');
    });

    it('commits NO_RECOMMENDATION after a failed generation, or when no review exists', async () => {
      storedReview('REQ-13', {
        recommendationState: 'ready',
        recommendation: { ...recommendation('ALLOW'), generationStatus: 'UNAVAILABLE', recommendation: null },
      });
      const ledger = ledgerRecording();
      const failed = await decideWith('REQ-13', { decision: 'FORCE_ALLOW', reason: 'Model offline; checked manually.' }, ledger);
      expect(failed.llmAgreement).to.equal('NO_RECOMMENDATION');
      const absent = await decideWith('REQ-14', { decision: 'FORCE_DENY', reason: 'No recommendation was prepared.' }, ledger);
      expect(absent.llmAgreement).to.equal('NO_RECOMMENDATION');
      expect(ledger.calls.map((call) => call[6])).to.deep.equal(['NO_RECOMMENDATION', 'NO_RECOMMENDATION']);
    });

    it('waits while the recommendation is still being prepared and never commits', async () => {
      storedReview('REQ-15');
      const ledger = ledgerRecording();
      const outcome = await decideWith('REQ-15', { decision: 'FORCE_ALLOW', reason: 'too early' }, ledger);
      expect(outcome.status).to.equal(409);
      expect(ledger.calls).to.deep.equal([]);
    });

    it('ignores any agreement value the browser tries to send', async () => {
      storedReview('REQ-16', { recommendationState: 'ready', recommendation: recommendation('DENY') });
      const ledger = ledgerRecording();
      const outcome = await decideWith('REQ-16', {
        decision: 'FORCE_ALLOW', llmAgreement: 'AGREED', reason: 'Supervisor tasking.',
      }, ledger);
      expect(outcome.llmAgreement).to.equal('NOT_AGREED');
      expect(ledger.calls[0][6]).to.equal('NOT_AGREED');
    });

    it('rejects an unknown decision before anything reaches the ledger', async () => {
      const ledger = ledgerRecording();
      const outcome = await decideWith('REQ-17', { decision: 'MAYBE' }, ledger);
      expect(outcome.status).to.equal(400);
      expect(ledger.calls).to.deep.equal([]);
    });
  });
});
