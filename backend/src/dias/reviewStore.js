'use strict';

/**
 * Off-chain review store.
 *
 * The auditor screen needs what the ledger deliberately does not hold: the
 * requester's written justification, the recommendation object M, and the
 * auditor's note. All three live here, one JSON file per request; the ledger
 * keeps only their digests (h_J, h_M in κ, h_N in the decision), so each can be
 * checked against it.
 *
 * Every write replaces the whole entry through a temporary file and a rename, so
 * a reader never sees a half-written entry.
 */

const fs = require('fs');
const path = require('path');

const REVIEW_SCHEMA_VERSION = 'dias-offchain-review-v1';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * pending: waiting for the recommendation service; signed: M and κ stored, κ not
 * yet confirmed on the ledger; committed: κ on the ledger; commit-rejected: the
 * ledger refused κ for a lasting reason; failed: the service could not answer.
 * `ready` is the v2 state, kept so entries written before v3 still read.
 */
const RECOMMENDATION_STATE = Object.freeze({
  PENDING: 'pending',
  SIGNED: 'signed',
  COMMITTED: 'committed',
  COMMIT_REJECTED: 'commit-rejected',
  FAILED: 'failed',
  READY: 'ready',
});

function createReviewStore(dir, { now = () => new Date(), log = console } = {}) {
  if (!dir) throw new Error('review store requires a directory');

  function fileFor(requestId) {
    if (!SAFE_ID.test(requestId || '')) throw new Error('requestId has invalid format');
    return path.join(dir, `${requestId}.json`);
  }

  function read(requestId) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(requestId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function write(entry) {
    const file = fileFor(entry.requestId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return entry;
  }

  /** Record a newly committed request that waits for the auditor. */
  function create({ request, justification }) {
    const timestamp = now().toISOString();
    return write({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      requestId: request.requestId,
      recordId: request.recordId,
      requesterUsername: request.requester.username,
      verifiedRequest: request.verifiedRequest,
      verifiedRequestHash: request.verifiedRequestHash,
      requesterClaims: request.requesterClaims,
      requesterClaimsHash: request.requesterClaimsHash,
      justification,
      justificationHash: request.justificationHash,
      policyVersion: request.policyVersion ?? null,
      policyHash: request.policyHash ?? null,
      recommendationState: RECOMMENDATION_STATE.PENDING,
      recommendation: null,
      auditorNote: null,
      stagedNotes: [],
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
    });
  }

  /**
   * The entry for a request this store has no review for (the request never
   * reached this backend, or its review was lost): it holds only notes, so a
   * note can still be made durable before its decision.
   */
  function noteOnlyEntry(requestId, recordId) {
    const timestamp = now().toISOString();
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      requestId,
      recordId: recordId ?? null,
      justification: null,
      recommendationState: null,
      recommendation: null,
      auditorNote: null,
      stagedNotes: [],
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
    };
  }

  /**
   * Stage an auditor note before its decision is submitted (design §11). A note
   * staged again with the same digest replaces the earlier copy.
   */
  function stageNote(requestId, { noteHash, reason, decision, auditorUsername, recordId }) {
    const current = read(requestId) || noteOnlyEntry(requestId, recordId);
    const timestamp = now().toISOString();
    const others = (current.stagedNotes || []).filter((note) => note.noteHash !== noteHash);
    return write({
      ...current,
      stagedNotes: [...others, { noteHash, reason, decision, auditorUsername, stagedAtUtc: timestamp }],
      updatedAtUtc: timestamp,
    });
  }

  /**
   * The decision is on the ledger: its note becomes the auditor note. A request
   * is decided once, so no other staged note can ever commit and all are cleared.
   */
  function commitNote(requestId, note) {
    return update(requestId, { auditorNote: { ...note, state: 'committed' }, stagedNotes: [] });
  }

  /** Remove one staged note whose digest can no longer be committed. */
  function dropStagedNote(requestId, noteHash) {
    const current = read(requestId);
    if (!current) return null;
    return update(requestId, {
      stagedNotes: (current.stagedNotes || []).filter((note) => note.noteHash !== noteHash),
    });
  }

  /** Replace selected fields, returning the new entry. */
  function update(requestId, fields) {
    const current = read(requestId);
    if (!current) throw new Error(`no off-chain review exists for request '${requestId}'`);
    return write({ ...current, ...fields, updatedAtUtc: now().toISOString() });
  }

  /** Every readable entry. A damaged file is reported and skipped, never fatal. */
  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return read(name.slice(0, -'.json'.length));
        } catch (error) {
          log.error(`[dias] skipping unreadable off-chain review ${name}: ${error.message}`);
          return null;
        }
      })
      .filter(Boolean);
  }

  return Object.freeze({
    create, read, update, list, stageNote, commitNote, dropStagedNote, dir,
  });
}

module.exports = { RECOMMENDATION_STATE, REVIEW_SCHEMA_VERSION, createReviewStore };
