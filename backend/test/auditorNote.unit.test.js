'use strict';

/**
 * Plan step 11 (backend side): the auditor note is made durable before its
 * decision is submitted, and every way the submission can end leaves the note
 * in a known state (design §11; paper §IV-E, Algorithm 1 lines 18 and 29–30).
 *
 *   staged    the note is on disk; the decision is not known to be committed;
 *   committed the ledger holds the decision with this note's digest h_N;
 *   dropped   the ledger refused the decision, or another decision closed the
 *             request, so this note's digest can never be committed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const accessRouter = require('../src/routes/access');
const { createReviewStore } = require('../src/dias/reviewStore');
const { NOTE_MAX_CHARS, reconcileStagedNotes } = require('../src/dias/auditorNotes');
const { hashText } = require('../../chaincode/crimerecords/lib/dias/commitments');
const { auditor, commitmentPair, committedRequest } = require('./fixtures/decisionFixtures');

const REASON = 'The case lead confirmed the assignment by phone.';
const NOTE_HASH = hashText('note', REASON);

/** The decision record the contract writes, as GetAuditorReview returns it. */
function ledgerDecision(requestId, { decision = 'FORCE_ALLOW', noteHash = NOTE_HASH, llmAgreement = 'NOT_AGREED' } = {}) {
  return {
    auditorDecisionId: `AUDIT-${requestId}`, requestId, decision, llmRecommendation: 'DENY',
    generationStatus: 'OK', llmAgreement, noteHash, createdAuthorizationId: null,
    decidedAtUtc: '2026-10-02T10:00:00.000Z', txId: `tx-${requestId}`,
  };
}

/**
 * A ledger whose review read returns `commitment` and, once `decided` is set, the
 * decision. `submit` runs `onSubmit` first, so a test can look at the store at the
 * moment the decision is sent, or make the submission fail.
 */
function fakeLedger({ commitment, onSubmit = async () => {} }) {
  const state = { decided: null, submissions: [] };
  return {
    state,
    evaluate: async (org, user, contract, fn, requestId) => ({
      request: { ...committedRequest(requestId), status: state.decided ? 'granted' : 'awaiting-auditor', outcomeId: state.decided ? `OUT-${requestId}` : null },
      commitment,
      decision: state.decided,
    }),
    submit: async (...args) => {
      state.submissions.push(args.slice(3));
      await onSubmit(args, state);
      const [, , , , requestId, decision, noteHash] = args;
      state.decided = ledgerDecision(requestId, { decision, noteHash: noteHash || null });
      return {
        auditorDecision: state.decided,
        accessOutcome: { outcome: decision === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED' },
        dynamicAuthorization: null,
      };
    },
  };
}

const timeout = () => Object.assign(new Error('commit status request timed out'), { code: 4 });
const refusal = (message) => Object.assign(new Error('endorse failed'), { details: [{ message }] });

describe('auditor note made durable before its decision (plan step 11)', () => {
  let dir;
  let store;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-notes-'));
    store = createReviewStore(dir);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function reviewWithCommitment(requestId, value = 'DENY') {
    const pair = commitmentPair(requestId, value);
    store.create({ request: committedRequest(requestId), justification: 'Reviewing the FIR.' });
    store.update(requestId, {
      recommendationState: 'committed', recommendationObject: pair.recommendationObject, commitment: pair.commitment,
    });
    return pair;
  }

  const decide = (requestId, body, ledger) => accessRouter.decide({ user: auditor, requestId, body, ledger, store });

  describe('the review store', () => {
    it('keeps a staged note on disk, readable by a new process', () => {
      reviewWithCommitment('REQ-1');
      store.stageNote('REQ-1', { noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      const reread = createReviewStore(dir).read('REQ-1');
      expect(reread.stagedNotes).to.have.length(1);
      expect(reread.stagedNotes[0]).to.include({ noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW' });
    });

    it('stages a note even when the request has no review entry', () => {
      store.stageNote('REQ-2', {
        noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_DENY', auditorUsername: 'sp.north', recordId: 'FIR-1',
      });
      const entry = store.read('REQ-2');
      expect(entry).to.include({ requestId: 'REQ-2', recordId: 'FIR-1', justification: null, recommendationState: null });
      expect(entry.stagedNotes.map((note) => note.noteHash)).to.deep.equal([NOTE_HASH]);
    });

    it('commits one note and clears every other staged note; drops one note by digest', () => {
      reviewWithCommitment('REQ-3');
      const other = hashText('note', 'An earlier draft.');
      store.stageNote('REQ-3', { noteHash: other, reason: 'An earlier draft.', decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      store.stageNote('REQ-3', { noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      store.dropStagedNote('REQ-3', other);
      expect(store.read('REQ-3').stagedNotes.map((note) => note.noteHash)).to.deep.equal([NOTE_HASH]);
      store.commitNote('REQ-3', { decision: 'FORCE_ALLOW', reason: REASON, noteHash: NOTE_HASH, txId: 'tx-3' });
      const entry = store.read('REQ-3');
      expect(entry.auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH, txId: 'tx-3' });
      expect(entry.stagedNotes).to.deep.equal([]);
    });
  });

  describe('the decision route', () => {
    it('writes the note to disk before the decision is sent, then marks it committed', async () => {
      const { commitment } = reviewWithCommitment('REQ-10');
      let onDiskAtSubmit = null;
      const ledger = fakeLedger({
        commitment,
        onSubmit: async () => { onDiskAtSubmit = createReviewStore(dir).read('REQ-10').stagedNotes; },
      });
      const outcome = await decide('REQ-10', { decision: 'FORCE_ALLOW', reason: REASON }, ledger);
      expect(outcome.status).to.equal(201);
      expect(onDiskAtSubmit.map((note) => [note.noteHash, note.reason])).to.deep.equal([[NOTE_HASH, REASON]]);
      const entry = store.read('REQ-10');
      expect(entry.auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH, reason: REASON, llmAgreement: 'NOT_AGREED' });
      expect(entry.stagedNotes).to.deep.equal([]);
    });

    it('drops the note when the ledger refuses the decision, and passes the refusal on', async () => {
      const { commitment } = reviewWithCommitment('REQ-11');
      const refused = refusal('DIAS_AUDITOR_OUT_OF_DISTRICT: district-south may not decide district-north');
      const ledger = fakeLedger({ commitment, onSubmit: async () => { throw refused; } });
      await decide('REQ-11', { decision: 'FORCE_ALLOW', reason: REASON }, ledger)
        .then(() => expect.fail('expected the refusal'), (error) => expect(error).to.equal(refused));
      const entry = store.read('REQ-11');
      expect(entry.stagedNotes).to.deep.equal([]);
      expect(entry.auditorNote).to.equal(null);
    });

    it('recognizes a decision that committed although the response was lost', async () => {
      const { commitment } = reviewWithCommitment('REQ-12');
      const ledger = fakeLedger({
        commitment,
        onSubmit: async (args, state) => {
          state.decided = ledgerDecision('REQ-12');
          throw timeout();
        },
      });
      const outcome = await decide('REQ-12', { decision: 'FORCE_ALLOW', reason: REASON }, ledger);
      expect(outcome).to.include({ status: 201, recoveredFromLedger: true, llmAgreement: 'NOT_AGREED' });
      expect(outcome.data.auditorDecision).to.include({ noteHash: NOTE_HASH, txId: 'tx-REQ-12' });
      expect(outcome.data.accessOutcome).to.include({ outcome: 'GRANTED', outcomeId: 'OUT-REQ-12' });
      expect(store.read('REQ-12').auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH });
    });

    it('keeps the note staged and says the decision is unconfirmed when the ledger shows nothing yet', async () => {
      const { commitment } = reviewWithCommitment('REQ-13');
      const ledger = fakeLedger({ commitment, onSubmit: async () => { throw timeout(); } });
      const outcome = await decide('REQ-13', { decision: 'FORCE_ALLOW', reason: REASON }, ledger);
      expect(outcome.status).to.equal(503);
      expect(outcome.error).to.match(/not confirmed/);
      expect(store.read('REQ-13').stagedNotes.map((note) => note.noteHash)).to.deep.equal([NOTE_HASH]);
    });

    it('never submits a second decision for a request already decided, and settles its note', async () => {
      const { commitment } = reviewWithCommitment('REQ-14');
      store.stageNote('REQ-14', { noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      const ledger = fakeLedger({ commitment });
      ledger.state.decided = ledgerDecision('REQ-14');
      const outcome = await decide('REQ-14', { decision: 'FORCE_ALLOW', reason: REASON }, ledger);
      expect(outcome.status).to.equal(409);
      expect(outcome.error).to.match(/already decided/);
      expect(ledger.state.submissions).to.deep.equal([]);
      expect(store.read('REQ-14').auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH });
    });

    it('stages and commits an optional note on an agreeing decision, and none when there is no text', async () => {
      const { commitment } = reviewWithCommitment('REQ-15', 'ALLOW');
      const withNote = await decide('REQ-15', { decision: 'FORCE_ALLOW', reason: REASON }, fakeLedger({ commitment }));
      expect(withNote.llmAgreement).to.equal('AGREED');
      expect(store.read('REQ-15').auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH });
      const second = reviewWithCommitment('REQ-16', 'ALLOW');
      await decide('REQ-16', { decision: 'FORCE_ALLOW' }, fakeLedger({ commitment: second.commitment }));
      expect(store.read('REQ-16').auditorNote).to.include({ state: 'committed', noteHash: null, reason: null });
    });

    it('accepts notes up to 2,000 characters and refuses longer or blank required notes', async () => {
      expect(NOTE_MAX_CHARS).to.equal(2000);
      const { commitment } = reviewWithCommitment('REQ-17');
      const tooLong = await decide('REQ-17', { decision: 'FORCE_ALLOW', reason: 'x'.repeat(2001) }, fakeLedger({ commitment }));
      expect(tooLong.status).to.equal(400);
      const blank = await decide('REQ-17', { decision: 'FORCE_ALLOW', reason: '   \n ' }, fakeLedger({ commitment }));
      expect(blank.status).to.equal(400);
      expect(blank.error).to.match(/reason is required/);
      const longest = await decide('REQ-17', { decision: 'FORCE_ALLOW', reason: 'y'.repeat(2000) }, fakeLedger({ commitment }));
      expect(longest.status).to.equal(201);
    });

    it('stores a required note durably even when the request has no review entry', async () => {
      const ledger = fakeLedger({ commitment: null });
      const outcome = await decide('REQ-18', { decision: 'FORCE_DENY', reason: REASON }, ledger);
      expect(outcome).to.include({ status: 201, llmAgreement: 'NO_RECOMMENDATION', generationStatus: 'NOT_COMMITTED' });
      expect(store.read('REQ-18').auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH, reason: REASON });
    });
  });

  describe('settling notes left staged by a stopped process', () => {
    it('commits, drops or keeps each staged note according to the ledger', async () => {
      const otherNote = hashText('note', 'A different auditor note.');
      for (const requestId of ['REQ-20', 'REQ-21', 'REQ-22', 'REQ-23']) {
        reviewWithCommitment(requestId);
        store.stageNote(requestId, { noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      }
      const onLedger = {
        'REQ-20': { status: 'granted', decision: ledgerDecision('REQ-20') },
        'REQ-21': { status: 'granted', decision: ledgerDecision('REQ-21', { noteHash: otherNote }) },
        'REQ-22': { status: 'awaiting-auditor', decision: null },
        'REQ-23': { status: 'expired', decision: null },
      };
      const ledger = {
        evaluate: async (org, user, contract, fn, requestId) => ({
          request: { ...committedRequest(requestId), status: onLedger[requestId].status },
          commitment: null,
          decision: onLedger[requestId].decision,
        }),
      };
      const summary = await reconcileStagedNotes({
        store, ledger, identity: { org: 'audit', fabricUser: 'sp.north' }, log: { log() {}, error() {} },
      });
      expect(summary).to.deep.equal({ committed: 1, dropped: 2, stillStaged: 1, unreadable: 0 });
      expect(store.read('REQ-20').auditorNote).to.include({ state: 'committed', noteHash: NOTE_HASH });
      expect(store.read('REQ-21').auditorNote).to.equal(null);
      expect(store.read('REQ-21').stagedNotes).to.deep.equal([]);
      expect(store.read('REQ-22').stagedNotes.map((note) => note.noteHash)).to.deep.equal([NOTE_HASH]);
      expect(store.read('REQ-23').stagedNotes).to.deep.equal([]);
    });

    it('leaves a note staged when the ledger cannot be read, and counts it', async () => {
      reviewWithCommitment('REQ-30');
      store.stageNote('REQ-30', { noteHash: NOTE_HASH, reason: REASON, decision: 'FORCE_ALLOW', auditorUsername: 'sp.north' });
      const ledger = { evaluate: async () => { throw new Error('peer unreachable'); } };
      const errors = [];
      const summary = await reconcileStagedNotes({
        store, ledger, identity: { org: 'audit', fabricUser: 'sp.north' }, log: { log() {}, error: (line) => errors.push(line) },
      });
      expect(summary).to.deep.equal({ committed: 0, dropped: 0, stillStaged: 0, unreadable: 1 });
      expect(store.read('REQ-30').stagedNotes).to.have.length(1);
      expect(errors.join(' ')).to.match(/REQ-30.*peer unreachable/);
    });
  });
});
