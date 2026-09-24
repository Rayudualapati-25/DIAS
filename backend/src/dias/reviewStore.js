'use strict';

/**
 * Off-chain review store.
 *
 * The auditor screen needs two things the ledger deliberately does not hold: the
 * requester's written justification and the LLM recommendation this backend
 * generated. Both live here, one JSON file per request. The ledger keeps only who
 * requested which record and the auditor decision with its LLM agreement.
 *
 * Every write replaces the whole entry through a temporary file and a rename, so
 * a reader never sees a half-written entry.
 */

const fs = require('fs');
const path = require('path');

const REVIEW_SCHEMA_VERSION = 'dias-offchain-review-v1';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RECOMMENDATION_STATE = Object.freeze({ PENDING: 'pending', READY: 'ready' });

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
      justification,
      recommendationState: RECOMMENDATION_STATE.PENDING,
      recommendation: null,
      auditorNote: null,
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
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

  return Object.freeze({ create, read, update, list, dir });
}

module.exports = { RECOMMENDATION_STATE, REVIEW_SCHEMA_VERSION, createReviewStore };
