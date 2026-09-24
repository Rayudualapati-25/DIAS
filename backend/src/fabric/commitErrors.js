'use strict';

/**
 * Commit conflicts.
 *
 * Fabric validates every transaction at commit time. One whose read set was
 * changed by a transaction committed first (MVCC_READ_CONFLICT) or whose range
 * query would now return different keys (PHANTOM_READ_CONFLICT) is marked
 * invalid and writes nothing. Proposing it again simulates it against the new
 * state, where the chaincode re-checks everything, so a bounded retry is safe.
 */

/** Transaction validation codes for MVCC_READ_CONFLICT and PHANTOM_READ_CONFLICT. */
const COMMIT_CONFLICT_CODES = Object.freeze([11, 12]);
const COMMIT_CONFLICT_RETRIES = Number(process.env.COMMIT_CONFLICT_RETRIES || 2);
const COMMIT_CONFLICT_MESSAGE = 'the ledger changed while this transaction was being committed, '
  + 'so nothing was recorded; try again';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isCommitConflict(error) {
  return Boolean(error)
    && error.name === 'CommitError'
    && COMMIT_CONFLICT_CODES.includes(error.code);
}

/** Run `operation`, proposing it again after a commit conflict, up to `retries` times. */
async function withCommitRetry(operation, { retries = COMMIT_CONFLICT_RETRIES, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isCommitConflict(error) || attempt >= retries) throw error;
      await sleep(100 * (2 ** attempt));
    }
  }
}

module.exports = {
  COMMIT_CONFLICT_CODES, COMMIT_CONFLICT_MESSAGE, isCommitConflict, withCommitRetry,
};
