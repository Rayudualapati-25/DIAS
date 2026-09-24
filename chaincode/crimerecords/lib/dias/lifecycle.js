'use strict';

/**
 * DIAS request and authorization lifecycle events.
 *
 * Every workflow stage is its own ledger state entry, keyed by its owner (request
 * or authorization ID) and a zero-padded sequence number, so the ordered history
 * can be read back from committed Fabric state together with the transaction
 * that wrote each stage. Fabric keeps one chaincode event per transaction, so that
 * event lists every stage the transaction committed.
 */

const { putJson } = require('../util/state');

const LIFECYCLE_EVENT_SCHEMA_VERSION = 'dias-lifecycle-event-v2';
const REQUEST_EVENT_KEY = 'diasRequestEvent';
const AUTHORIZATION_EVENT_KEY = 'diasAuthorizationEvent';
const CHAINCODE_EVENT_NAME = 'DIASLifecycle';
const SEQUENCE_WIDTH = 6;

const EVENT = Object.freeze({
  ACCESS_REQUEST_SUBMITTED: 'ACCESS_REQUEST_SUBMITTED',
  DYNAMIC_AUTHORIZATION_CHECKED: 'DYNAMIC_AUTHORIZATION_CHECKED',
  AUDITOR_REVIEW_SKIPPED: 'AUDITOR_REVIEW_SKIPPED',
  AUDITOR_DECISION_RECORDED: 'AUDITOR_DECISION_RECORDED',
  DYNAMIC_AUTHORIZATION_CREATED: 'DYNAMIC_AUTHORIZATION_CREATED',
  DYNAMIC_AUTHORIZATION_SUPERSEDED: 'DYNAMIC_AUTHORIZATION_SUPERSEDED',
  DYNAMIC_AUTHORIZATION_REVOKED: 'DYNAMIC_AUTHORIZATION_REVOKED',
  DYNAMIC_AUTHORIZATION_EXPIRED: 'DYNAMIC_AUTHORIZATION_EXPIRED',
  ACCESS_OUTCOME_RECORDED: 'ACCESS_OUTCOME_RECORDED',
});

const sequenceKey = (seq) => String(seq).padStart(SEQUENCE_WIDTH, '0');

function actorFrom(caller, identityHash) {
  return {
    username: caller.enrollmentId || null,
    mspId: caller.mspId,
    role: caller.role || null,
    identityHash,
  };
}

async function appendEvents(ctx, { keyType, ownerField, ownerId, lastSeq, actor, events }) {
  const txId = ctx.stub.getTxID();
  const timestamp = ctx.stub.getDateTimestamp().toISOString();
  const records = events.map((event, index) => ({
    docType: keyType,
    schemaVersion: LIFECYCLE_EVENT_SCHEMA_VERSION,
    [ownerField]: ownerId,
    seq: lastSeq + index + 1,
    eventType: event.type,
    txId,
    timestamp,
    actor,
    data: event.data || {},
  }));
  for (const record of records) {
    await putJson(
      ctx, ctx.stub.createCompositeKey(keyType, [ownerId, sequenceKey(record.seq)]), record
    );
  }
  return { lastSeq: lastSeq + records.length, records };
}

function appendRequestEvents(ctx, { requestId, lastSeq, actor, events }) {
  return appendEvents(ctx, {
    keyType: REQUEST_EVENT_KEY, ownerField: 'requestId', ownerId: requestId, lastSeq, actor, events,
  });
}

function appendAuthorizationEvents(ctx, { authorizationId, lastSeq, actor, events }) {
  return appendEvents(ctx, {
    keyType: AUTHORIZATION_EVENT_KEY,
    ownerField: 'authorizationId',
    ownerId: authorizationId,
    lastSeq,
    actor,
    events,
  });
}

async function readEvents(ctx, keyType, ownerId) {
  const iterator = await ctx.stub.getStateByPartialCompositeKey(keyType, [ownerId]);
  const records = [];
  let result = await iterator.next();
  while (!result.done) {
    records.push(JSON.parse(result.value.value.toString()));
    result = await iterator.next();
  }
  await iterator.close();
  return records.sort((left, right) => left.seq - right.seq);
}

const readRequestEvents = (ctx, requestId) => readEvents(ctx, REQUEST_EVENT_KEY, requestId);
const readAuthorizationEvents = (ctx, authorizationId) => readEvents(
  ctx, AUTHORIZATION_EVENT_KEY, authorizationId
);

/** The transaction's single chaincode event, naming every stage it committed. */
function emitLifecycle(ctx, payload) {
  ctx.stub.setEvent(CHAINCODE_EVENT_NAME, Buffer.from(JSON.stringify({
    schemaVersion: LIFECYCLE_EVENT_SCHEMA_VERSION,
    txId: ctx.stub.getTxID(),
    ...payload,
  })));
}

module.exports = {
  AUTHORIZATION_EVENT_KEY,
  CHAINCODE_EVENT_NAME,
  EVENT,
  LIFECYCLE_EVENT_SCHEMA_VERSION,
  REQUEST_EVENT_KEY,
  actorFrom,
  appendAuthorizationEvents,
  appendRequestEvents,
  emitLifecycle,
  readAuthorizationEvents,
  readRequestEvents,
};
