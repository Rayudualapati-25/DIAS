'use strict';

/** The auditor note, made durable before its decision. */

const { DOMAINS, hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');

const NOTE_MAX_CHARS = 2000;
const CONTRACT = 'AccessContract';
const AWAITING_AUDITOR = 'awaiting-auditor';
const SETTLED_AS = Object.freeze({ committed: 'committed', dropped: 'dropped', 'still-staged': 'stillStaged' });

/** The note as stored and hashed: the trimmed text, or '' when there is none. */
const normalizeNote = (text) => (typeof text === 'string' ? text.trim() : '');

/** h_N of a normalized note, or '' when there is no note. */
const noteHashOf = (text) => (text ? hashText(DOMAINS.NOTE, text) : '');

/** The off-chain record of a committed decision's note; the ledger's values win. */
function committedNoteRecord(recorded, local) {
  return {
    decision: recorded.decision ?? local.decision,
    llmRecommendation: recorded.llmRecommendation ?? local.llmRecommendation ?? null,
    generationStatus: recorded.generationStatus ?? local.generationStatus ?? null,
    llmAgreement: recorded.llmAgreement ?? local.llmAgreement ?? null,
    reason: local.reason || null,
    noteHash: recorded.noteHash !== undefined ? recorded.noteHash : (local.noteHash || null),
    auditorUsername: local.auditorUsername ?? null,
    decidedAtUtc: recorded.decidedAtUtc ?? null,
    txId: recorded.txId ?? null,
  };
}

/** Settle the staged notes of one request against the ledger's review read. */
function settleStagedNotes({ store, requestId, review }) {
  const entry = store.read(requestId);
  const staged = entry ? entry.stagedNotes || [] : [];
  const decision = review && review.decision;
  const closed = decision || (review && review.request && review.request.status !== AWAITING_AUDITOR);
  if (!closed) return 'still-staged';
  const match = decision ? staged.find((note) => note.noteHash === (decision.noteHash || '')) : null;
  if (match) {
    store.commitNote(requestId, committedNoteRecord(decision, match));
    return 'committed';
  }
  if (staged.length > 0) store.update(requestId, { stagedNotes: [] });
  return 'dropped';
}

/** Settle every note a stopped process left staged. Run once at start-up. */
async function reconcileStagedNotes({ store, ledger, identity, log = console }) {
  const summary = { committed: 0, dropped: 0, stillStaged: 0, unreadable: 0 };
  const waiting = store.list().filter((entry) => (entry.stagedNotes || []).length > 0);
  for (const entry of waiting) {
    try {
      const review = await ledger.evaluate(
        identity.org, identity.fabricUser, CONTRACT, 'GetAuditorReview', entry.requestId
      );
      summary[SETTLED_AS[settleStagedNotes({ store, requestId: entry.requestId, review })]] += 1;
    } catch (error) {
      summary.unreadable += 1;
      log.error(`[dias] ${entry.requestId} staged note not settled: ${error.message}`);
    }
  }
  return summary;
}

module.exports = {
  NOTE_MAX_CHARS,
  committedNoteRecord,
  normalizeNote,
  noteHashOf,
  reconcileStagedNotes,
  settleStagedNotes,
};
