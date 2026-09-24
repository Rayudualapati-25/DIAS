'use strict';

/**
 * The single way this chaincode writes a JSON object to ledger state.
 *
 * Fabric compares endorsers' write sets byte for byte, and JSON.stringify
 * preserves INSERTION order. So `JSON.stringify({ ...stored, field })`
 * serialises differently depending on whether `field` was already present in
 * the value that was read: present, and it keeps its original position; absent,
 * and it is appended. Once two peers' stored bytes for a key differ in ordering
 * they diverge permanently, and every later update to that key fails
 * endorsement with "ProposalResponsePayloads do not match" — identical content,
 * different bytes, no error that names the cause.
 *
 * Canonical serialisation removes insertion order from the result entirely, so
 * the stored bytes are a function of content alone. Every JSON state write goes
 * through here; `chaincode/crimerecords/test/canonicalState.test.js` fails the
 * build if a contract writes JSON any other way.
 *
 * Raw, deliberately non-JSON payloads — the requester's question text, evidence
 * detail — are written directly with putPrivateData and are not affected.
 */

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
