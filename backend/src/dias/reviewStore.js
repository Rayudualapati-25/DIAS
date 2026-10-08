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
 * a reader never sees a half-written entry. With a cipher, every entry is written
 * encrypted and only encrypted entries are read (design §10). `sealWithCurrentKey`,
 * run at start-up, encrypts entries an earlier version left in the clear and
 * re-seals those of an earlier key.
 */

const fs = require('fs');
const path = require('path');
const { isEncryptedReview } = require('./reviewCipher');

const REVIEW_SCHEMA_VERSION = 'dias-offchain-review-v1';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/**
 * pending: waiting for the LLM recommendation; signed: M and κ stored, κ not
 * yet confirmed on the ledger; committed: κ on the ledger; commit-rejected: the
 * ledger refused κ for a lasting reason; failed: the recommender could not answer.
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

/** The recommendation is still being produced, or its commitment is not confirmed yet. */
const PREPARING_STATES = Object.freeze([RECOMMENDATION_STATE.PENDING, RECOMMENDATION_STATE.SIGNED]);
const isRecommendationPreparing = (entry) => Boolean(entry) && PREPARING_STATES.includes(entry.recommendationState);

function createReviewStore(dir, { now = () => new Date(), log = console, cipher = null } = {}) {
  if (!dir) throw new Error('review store requires a directory');

  function fileFor(requestId) {
    if (!SAFE_ID.test(requestId || '')) throw new Error('requestId has invalid format');
    return path.join(dir, `${requestId}.json`);
  }

  /** What the file holds: an encrypted envelope, an entry in the clear, or null. */
  function readStored(requestId) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(requestId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function read(requestId) {
    const stored = readStored(requestId);
    if (stored === null) return null;
    if (!isEncryptedReview(stored)) {
      // An encrypted store does not take a file in the clear at face value.
      if (cipher) throw new Error(`the review of '${requestId}' is not encrypted; restart the backend to encrypt it`);
      return stored;
    }
    if (!cipher) throw new Error(`the review of '${requestId}' is encrypted and this store has no key`);
    return cipher.open(requestId, stored);
  }

  /**
   * Read for a view that must not fail because of one entry: an entry that cannot
   * be opened (a retired key, a damaged file) is reported and treated as absent.
   * A decision on such a request is then refused as "recommendation object not
   * available", never taken on something nobody could read.
   */
  function readSafely(requestId) {
    fileFor(requestId);
    try {
      return read(requestId);
    } catch (error) {
      log.error(`[dias] off-chain review of ${requestId} could not be read: ${error.message}`);
      return null;
    }
  }

  function write(entry) {
    const file = fileFor(entry.requestId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const stored = cipher ? cipher.seal(entry.requestId, entry) : entry;
    // Flushed before the rename, so a crash leaves either the old entry or the new one.
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(stored, null, 2)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
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

  /** What one stored file needs at start-up: 'encrypted', 'resealed', 'unreadable' or null. */
  function sealOne(requestId) {
    const stored = readStored(requestId);
    if (stored === null) return null;
    if (!isEncryptedReview(stored)) {
      if (stored.requestId !== requestId) throw new Error('its request identifier does not match its file name');
      write(stored);
      return 'encrypted';
    }
    const entry = cipher.open(requestId, stored);
    if (stored.keyId === cipher.keyId) return null;
    write(entry);
    return 'resealed';
  }

  /**
   * Bring every stored entry under the current key, at start-up: encrypt what an
   * earlier version left in the clear, and re-seal what an earlier key sealed, so
   * that key can be retired. An entry that cannot be opened is counted, reported
   * and left exactly as it is.
   */
  function sealWithCurrentKey() {
    const counts = { encrypted: 0, resealed: 0, unreadable: 0 };
    if (!cipher || !fs.existsSync(dir)) return counts;
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).reduce((total, name) => {
      try {
        const done = sealOne(name.slice(0, -'.json'.length));
        return done ? { ...total, [done]: total[done] + 1 } : total;
      } catch (error) {
        log.error(`[dias] off-chain review ${name} was left as it is: ${error.message}`);
        return { ...total, unreadable: total.unreadable + 1 };
      }
    }, counts);
  }

  return Object.freeze({
    create, read, readSafely, update, list, stageNote, commitNote, dropStagedNote, sealWithCurrentKey, dir,
  });
}

module.exports = {
  RECOMMENDATION_STATE, REVIEW_SCHEMA_VERSION, createReviewStore, isRecommendationPreparing,
};
