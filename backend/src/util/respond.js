'use strict';

/** Consistent API envelope + async error handling. */

const { COMMIT_CONFLICT_MESSAGE, isCommitConflict } = require('../fabric/commitErrors');

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data, error: null });
}

function fail(res, error, status = 400) {
  return res.status(status).json({ success: false, data: null, error });
}

/**
 * Wrap an async handler: chaincode rejections surface as 4xx with the
 * contract's message; a commit conflict that outlasted its retries is 409;
 * unexpected errors log server-side and return 500.
 */
function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (isCommitConflict(err)) return fail(res, COMMIT_CONFLICT_MESSAGE, 409);
      const message = extractChaincodeMessage(err);
      if (message) return fail(res, message, 422);
      // eslint-disable-next-line no-console
      console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
      return fail(res, 'internal error', 500);
    }
  };
}

/**
 * Pull the human-readable chaincode error out of a gateway error, if any.
 * The gateway prefixes each detail with "chaincode response 500,"; the person
 * reading the screen needs the contract's sentence, not the transport's.
 */
const CHAINCODE_PREFIX = /^chaincode response \d+,\s*/i;

function extractChaincodeMessage(err) {
  if (err && Array.isArray(err.details) && err.details.length > 0) {
    return err.details.map((d) => String(d.message).replace(CHAINCODE_PREFIX, '')).join('; ');
  }
  if (err && typeof err.message === 'string' &&
      (err.message.includes('unauthorized') || err.message.includes('does not exist') ||
       err.message.includes('already') || err.message.includes('must be'))) {
    return err.message;
  }
  return null;
}

module.exports = { ok, fail, asyncRoute };
