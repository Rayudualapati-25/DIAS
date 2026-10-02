'use strict';

/**
 * DIAS access routes: request submission and the auditor decision.
 *
 * What the routes must get right is what reaches the ledger: the request with
 * only the justification's digest, and the auditor decision with only the note's
 * digest. The recommendation the decision is compared with is the commitment κ
 * already on the ledger; the routes refuse to decide on an object that does not
 * match it. Everything else stays off-chain. Note staging is tested in
 * auditorNote.unit.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const accessRouter = require('../src/routes/access');
const { createReviewStore } = require('../src/dias/reviewStore');
const { hashText } = require('../../chaincode/crimerecords/lib/dias/commitments');
const {
  auditor, commitmentPair, committedRequest, recommendation, requester,
} = require('./fixtures/decisionFixtures');

/** A ledger that serves GetAuditorReview with `commitment` and records submissions. */
function ledgerRecording(commitment = null) {
  const calls = [];
  return {
    calls,
    evaluate: async (org, user, contract, fn, requestId) => {
      calls.push(['evaluate', fn, requestId]);
      return { request: committedRequest(requestId), commitment };
    },
    submit: async (...args) => {
      calls.push(args);
      return {
        auditorDecision: { decidedAtUtc: '2026-09-15T10:00:00.000Z', txId: 'tx-1' },
        accessOutcome: { outcome: args[5] === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED' },
        dynamicAuthorization: null,
      };
    },
  };
}

const submissions = (ledger) => ledger.calls.filter((call) => call[0] !== 'evaluate');

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

  describe('decisions on an overdue request', () => {
    it('records the expiry and passes the refusal on when the deadline has passed', async () => {
      const pair = commitmentPair('REQ-20', 'ALLOW');
      storedReview('REQ-20', {
        recommendationState: 'committed', recommendation: pair.record,
        recommendationObject: pair.recommendationObject, commitment: pair.commitment,
      });
      const calls = [];
      const expired = Object.assign(new Error('endorse failed'), {
        details: [{ message: 'DIAS_REQUEST_EXPIRED: the review deadline has passed' }],
      });
      const ledger = {
        evaluate: async () => ({ request: committedRequest('REQ-20'), commitment: pair.commitment }),
        submit: async (...args) => {
          calls.push(args.slice(3, 5));
          if (args[3] === 'SubmitAuditorDecision') throw expired;
          return { request: { status: 'expired' } };
        },
      };
      await accessRouter.decide({
        user: auditor, requestId: 'REQ-20', body: { decision: 'FORCE_ALLOW' }, ledger, store,
      }).then(() => expect.fail('expected the refusal'), (error) => expect(error).to.equal(expired));
      expect(calls).to.deep.equal([
        ['SubmitAuditorDecision', 'REQ-20'], ['ExpirePendingRequest', 'REQ-20'],
      ]);
    });
  });

  describe('decisions under a retired policy', () => {
    it('closes the request and passes the refusal on', async () => {
      const pair = commitmentPair('REQ-21', 'DENY');
      storedReview('REQ-21', {
        recommendationState: 'committed', recommendation: pair.record,
        recommendationObject: pair.recommendationObject, commitment: pair.commitment,
      });
      const calls = [];
      const stale = Object.assign(new Error('endorse failed'), {
        details: [{ message: 'DIAS_STALE_POLICY: made under a retired policy' }],
      });
      const ledger = {
        evaluate: async () => ({ request: committedRequest('REQ-21'), commitment: pair.commitment }),
        submit: async (...args) => {
          calls.push(args[3]);
          if (args[3] === 'SubmitAuditorDecision') throw stale;
          return {};
        },
      };
      await accessRouter.decide({
        user: auditor, requestId: 'REQ-21', body: { decision: 'FORCE_DENY', reason: 'Policy changed.' }, ledger, store,
      }).then(() => expect.fail('expected the refusal'), (error) => expect(error).to.equal(stale));
      expect(calls).to.deep.equal(['SubmitAuditorDecision', 'ExpirePendingRequest']);
    });
  });

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
        requester, ['FIR-1', '{"action":"view","purpose":"investigation","emergencyDeclared":false}'], { ledger }
      );
      expect(captured.slice(0, 4)).to.deep.equal(['police', 'insp.test', 'AccessContract', 'CreateAccessRequest']);
      expect(captured).to.have.length(6);
      expect(captured.join(' ')).to.not.match(/justification/i);
    });

    it('sends the emergency as a requester claim, never as a verified fact', () => {
      const parsed = accessRouter.parseAccessRequest({
        recordId: 'FIR-1', action: 'view', purpose: 'investigation',
        justification: 'Urgent: suspect may flee.', emergencyDeclared: true,
      });
      expect(parsed.error).to.equal(undefined);
      expect(parsed.recordId).to.equal('FIR-1');
      expect(parsed.justification).to.equal('Urgent: suspect may flee.');
      expect(parsed.contractInput).to.deep.equal({
        action: 'view', purpose: 'investigation', emergencyDeclared: true,
        justificationHash: hashText('justification', 'Urgent: suspect may flee.'),
      });
      const plain = accessRouter.parseAccessRequest({
        recordId: 'FIR-1', action: 'view', purpose: 'investigation', justification: 'Routine review.',
      });
      expect(plain.contractInput.emergencyDeclared).to.equal(false);
    });

    it('refuses the retired emergencyFlag field with a pointer to its replacement', () => {
      const parsed = accessRouter.parseAccessRequest({
        recordId: 'FIR-1', action: 'view', purpose: 'investigation',
        justification: 'Routine review.', emergencyFlag: true,
      });
      expect(parsed.error).to.match(/emergencyFlag was replaced by emergencyDeclared/);
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
    it('joins the request, its commitment and the off-chain material, with the integrity verdict', () => {
      const pair = commitmentPair('REQ-4', 'DENY');
      const entry = storedReview('REQ-4', {
        recommendationState: 'committed', recommendation: pair.record,
        recommendationObject: pair.recommendationObject, commitment: pair.commitment,
      });
      const view = accessRouter.reviewView(committedRequest('REQ-4'), pair.commitment, entry);
      expect(view).to.include({ justification: 'Reviewing the FIR.', recommendationState: 'committed' });
      expect(view.commitment).to.deep.equal(pair.commitment);
      expect(view.recommendationObject).to.deep.equal(pair.recommendationObject);
      expect(view.integrity.status).to.equal('verified');
      expect(accessRouter.reviewView(committedRequest('REQ-5'), null, null)).to.include({
        justification: null, recommendationState: 'not-generated', recommendation: null, commitment: null,
      });
    });
  });

  describe('auditor decision (v3: agreement from the ledger commitment)', () => {
    const decideWith = (requestId, body, ledger) => accessRouter.decide({
      user: auditor, requestId, body, ledger, store,
    });

    function committedReview(requestId, value, generationStatus) {
      const pair = commitmentPair(requestId, value, generationStatus);
      storedReview(requestId, {
        recommendationState: 'committed', recommendation: pair.record,
        recommendationObject: pair.recommendationObject, commitment: pair.commitment,
      });
      return pair;
    }

    it('records AGREED for FORCE_ALLOW over a committed ALLOW, with no note', async () => {
      const { commitment } = committedReview('REQ-10', 'ALLOW');
      const ledger = ledgerRecording(commitment);
      const outcome = await decideWith('REQ-10', { decision: 'FORCE_ALLOW' }, ledger);
      expect(outcome).to.include({ status: 201, llmRecommendation: 'ALLOW', llmAgreement: 'AGREED' });
      expect(submissions(ledger)).to.deep.equal([
        ['audit', 'sp.north', 'AccessContract', 'SubmitAuditorDecision', 'REQ-10', 'FORCE_ALLOW', '', ''],
      ]);
    });

    it('requires a note for FORCE_ALLOW over a committed DENY and sends only its digest', async () => {
      const { commitment } = committedReview('REQ-11', 'DENY');
      const ledger = ledgerRecording(commitment);
      const missingReason = await decideWith('REQ-11', { decision: 'FORCE_ALLOW' }, ledger);
      expect(missingReason.status).to.equal(400);
      expect(missingReason.error).to.match(/reason is required/);
      const reason = 'Verified supervisor tasking.';
      const outcome = await decideWith('REQ-11', {
        decision: 'FORCE_ALLOW', reason, validUntilUtc: '2026-12-01T00:00:00Z',
      }, ledger);
      expect(outcome).to.include({ status: 201, llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED' });
      expect(submissions(ledger)).to.have.length(1);
      expect(submissions(ledger)[0].slice(4)).to.deep.equal([
        'REQ-11', 'FORCE_ALLOW', hashText('note', reason), '2026-12-01T00:00:00Z',
      ]);
      expect(JSON.stringify(submissions(ledger))).to.not.include(reason);
    });

    it('records NOT_AGREED for FORCE_DENY over a committed ALLOW and refuses an expiry there', async () => {
      const { commitment } = committedReview('REQ-12', 'ALLOW');
      const ledger = ledgerRecording(commitment);
      const withExpiry = await decideWith('REQ-12', {
        decision: 'FORCE_DENY', reason: 'Restricted inquiry.', validUntilUtc: '2026-12-01T00:00:00Z',
      }, ledger);
      expect(withExpiry.status).to.equal(400);
      expect(withExpiry.error).to.match(/applies only when a dynamic authorization is created/);
      const outcome = await decideWith('REQ-12', { decision: 'FORCE_DENY', reason: 'Restricted inquiry.' }, ledger);
      expect(outcome.llmAgreement).to.equal('NOT_AGREED');
    });

    it('records NO_RECOMMENDATION for a committed failure, or when nothing was committed', async () => {
      const { commitment } = committedReview('REQ-13', null, 'INVALID_OUTPUT');
      const failed = await decideWith('REQ-13', { decision: 'FORCE_ALLOW', reason: 'Checked manually.' },
        ledgerRecording(commitment));
      expect(failed).to.include({ llmAgreement: 'NO_RECOMMENDATION', generationStatus: 'INVALID_OUTPUT' });
      storedReview('REQ-14', { recommendationState: 'failed', recommendation: { ...recommendation('ALLOW'), generationStatus: 'UNAVAILABLE', recommendation: null } });
      const absent = await decideWith('REQ-14', { decision: 'FORCE_DENY', reason: 'No recommendation was prepared.' },
        ledgerRecording(null));
      expect(absent).to.include({ llmAgreement: 'NO_RECOMMENDATION', generationStatus: 'NOT_COMMITTED' });
      const noReason = await decideWith('REQ-14', { decision: 'FORCE_DENY' }, ledgerRecording(null));
      expect(noReason.status).to.equal(400);
    });

    it('waits while the recommendation is being prepared or committed, and never submits', async () => {
      storedReview('REQ-15');
      const ledger = ledgerRecording(null);
      expect((await decideWith('REQ-15', { decision: 'FORCE_ALLOW', reason: 'too early' }, ledger)).status).to.equal(409);
      store.update('REQ-15', { recommendationState: 'signed' });
      expect((await decideWith('REQ-15', { decision: 'FORCE_ALLOW', reason: 'too early' }, ledger)).status).to.equal(409);
      expect(ledger.calls).to.deep.equal([]);
    });

    it('refuses to decide when the stored recommendation no longer matches its commitment', async () => {
      const { commitment, recommendationObject } = committedReview('REQ-18', 'DENY');
      store.update('REQ-18', {
        recommendationObject: { ...recommendationObject, output: { ...recommendationObject.output, reason: 'edited' } },
      });
      const ledger = ledgerRecording(commitment);
      const outcome = await decideWith('REQ-18', { decision: 'FORCE_ALLOW', reason: 'x' }, ledger);
      expect(outcome.status).to.equal(409);
      expect(outcome.error).to.match(/does not match its ledger commitment/);
      expect(submissions(ledger)).to.deep.equal([]);
    });

    it('refuses to decide when the committed recommendation object is missing', async () => {
      const { commitment } = committedReview('REQ-19', 'DENY');
      store.update('REQ-19', { recommendationObject: null });
      const outcome = await decideWith('REQ-19', { decision: 'FORCE_ALLOW', reason: 'x' }, ledgerRecording(commitment));
      expect(outcome.status).to.equal(409);
      expect(outcome.error).to.match(/not available/);
    });

    it('ignores any recommendation or agreement value the browser tries to send', async () => {
      const { commitment } = committedReview('REQ-16', 'DENY');
      const ledger = ledgerRecording(commitment);
      const outcome = await decideWith('REQ-16', {
        decision: 'FORCE_ALLOW', llmRecommendation: 'ALLOW', llmAgreement: 'AGREED', reason: 'Supervisor tasking.',
      }, ledger);
      expect(outcome.llmAgreement).to.equal('NOT_AGREED');
      expect(JSON.stringify(submissions(ledger))).to.not.match(/AGREED|"ALLOW"/);
    });

    it('rejects an unknown decision before anything reaches the ledger', async () => {
      const ledger = ledgerRecording();
      const outcome = await decideWith('REQ-17', { decision: 'MAYBE' }, ledger);
      expect(outcome.status).to.equal(400);
      expect(ledger.calls).to.deep.equal([]);
    });
  });
});
