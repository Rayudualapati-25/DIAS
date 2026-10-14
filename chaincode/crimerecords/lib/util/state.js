'use strict';

/** The single way this chaincode writes a JSON object to ledger state. */

const { canonicalize } = require('./validate');

/** Canonical bytes for one ledger value. Objects only; arrays are not assets. */
function serializeState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ledger state must be a JSON object');
  }
  return Buffer.from(canonicalize(value), 'utf8');
}

/** Write a JSON object to world state with deterministic bytes. */
async function putJson(ctx, key, value) {
  return ctx.stub.putState(key, serializeState(value));
}

module.exports = { putJson, serializeState };
