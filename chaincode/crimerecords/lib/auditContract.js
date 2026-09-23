'use strict';

/**
 * AuditContract — verification and reconstruction for reviewers.
 *
 * GetRequestAuditTrail rebuilds the DIAS lifecycle of one request from committed
 * Fabric world state and key history: who requested which record, the dynamic
 * authorization check, and the auditor decision with its LLM agreement. It does
 * not keep a separate log: every item it returns was written by the transaction
 * named next to it.
 */

const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const { SAFE_ID, hashObject, sha256 } = require('./util/validate');
const { putJson } = require('./util/state');
const { SEAL_AUTHORITY_ROLES, DISTRICT_HEAD_ROLES } = require('./policy/policyV1');
const KEYS = require('./dias/keys');
const { readAuthorizationEvents, readRequestEvents } = require('./dias/lifecycle');
const { AUTHORIZATION_KEY } = require('./dias/authorization');

const ACCESS_EVENT_KEY = 'accessEvent';

// Reviewer orgs: auditors, the court, and prosecution can reconstruct trails.
const REVIEWER_MSPS = [MSP.AUDIT, MSP.COURT, MSP.PROSECUTION];
/**
 * Membership of a reviewer organisation is not by itself oversight authority.
 * Reading a trail requires a district head, or the court authority that can open
 * a sealed record.
 */
const REVIEWER_ROLES = Object.freeze([...SEAL_AUTHORITY_ROLES, ...DISTRICT_HEAD_ROLES]);

function requireReviewer(ctx, action) {
  const caller = getCaller(ctx);
  requireMsp(caller, REVIEWER_MSPS, action);
  requireRole(caller, [...REVIEWER_ROLES], action);
  return caller;
}

const isReviewer = (caller) => REVIEWER_MSPS.includes(caller.mspId)
  && REVIEWER_ROLES.includes(caller.role);

async function readJson(ctx, key) {
  const data = await ctx.stub.getState(key);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

async function collect(iterator, map) {
  const items = [];
  let result = await iterator.next();
  while (!result.done) {
    items.push(map(result.value));
    result = await iterator.next();
  }
  await iterator.close();
  return items;
}

function historyTimestamp(timestamp) {
  if (!timestamp) return null;
  const seconds = typeof timestamp.seconds?.toNumber === 'function'
    ? timestamp.seconds.toNumber() : Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + Math.round((timestamp.nanos || 0) / 1e6)).toISOString();
}

async function keyHistory(ctx, key) {
  return collect(await ctx.stub.getHistoryForKey(key), (entry) => ({
    txId: entry.txId,
    timestamp: historyTimestamp(entry.timestamp),
    isDelete: Boolean(entry.isDelete),
  }));
}

function transactionsOf(events) {
  return events.reduce((transactions, event) => {
    const last = transactions[transactions.length - 1];
    if (last && last.txId === event.txId) {
      return [...transactions.slice(0, -1), { ...last, stages: [...last.stages, event.eventType] }];
    }
    return [...transactions, {
      txId: event.txId, timestamp: event.timestamp, actor: event.actor, stages: [event.eventType],
    }];
  }, []);
}

function summarize(request, auditorDecision, outcome) {
  return {
    requestId: request.requestId,
    requester: request.requester.username,
    stableUserId: request.requester.stableUserId,
    action: request.action,
    purpose: request.purpose,
    recordId: request.recordId,
    status: request.status,
    dynamicAuthorization: {
      outcome: request.dynamicAuthorizationCheck.outcome,
      authorizationId: request.dynamicAuthorizationCheck.authorizationId,
    },
    auditor: auditorDecision ? {
      username: auditorDecision.auditor.username,
      role: auditorDecision.auditor.role,
      decision: auditorDecision.decision,
      llmAgreement: auditorDecision.llmAgreement,
      txId: auditorDecision.txId,
    } : { status: request.auditorReviewStatus },
    createdAuthorizationId: request.createdAuthorizationId,
    outcome: outcome ? { outcome: outcome.outcome, basis: outcome.basis, txId: outcome.txId } : null,
  };
}

class AuditContract extends Contract {
  constructor() {
    super('AuditContract');
  }

  /**
   * Compare the hash recomputed by the backend over agency-held raw content
   * with the immutable commitment in Fabric metadata.
   */
  async VerifyRecordPayload(ctx, recordId, contentHash) {
    const record = await readJson(ctx, ctx.stub.createCompositeKey(KEYS.RECORD, [recordId]));
    if (!record) throw new Error(`record '${recordId}' does not exist`);
    return JSON.stringify({
      match: record.contentHash === contentHash,
      storedHash: record.contentHash,
      computedHash: contentHash,
      storage: 'agency-controlled-off-chain-vault',
    });
  }

  /**
   * Commit one authenticated API access event. The actor is always derived
   * from the signing certificate; callers cannot name a different actor.
   */
  async RecordAccessEvent(ctx, action, targetJson, outcome, statusCode) {
    const caller = getCaller(ctx);
    if (!SAFE_ID.test(action || '')) throw new Error('action must be a simple identifier');
    if (!['ok', 'failed', 'refused', 'rejected', 'error'].includes(outcome)) {
      throw new Error('outcome is invalid');
    }
    const status = Number(statusCode);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error('statusCode must be an HTTP status integer');
    }
    let target = null;
    try {
      target = JSON.parse(targetJson);
    } catch {
      throw new Error('target must be valid JSON');
    }
    if (Buffer.byteLength(targetJson, 'utf8') > 2048) {
      throw new Error('target exceeds 2048 byte limit');
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const event = {
      docType: 'applicationAccessEvent',
      actorIdentityHash: hashObject({ id: caller.id }),
      actorUsername: caller.enrollmentId,
      actorMsp: caller.mspId,
      actorRole: caller.role,
      action,
      target,
      outcome,
      status,
      timestamp,
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, ctx.stub.createCompositeKey(ACCESS_EVENT_KEY, [timestamp, event.txId]), event);
    ctx.stub.setEvent('ApplicationAccessRecorded', Buffer.from(JSON.stringify({
      action, outcome, txId: event.txId,
    })));
    return JSON.stringify(event);
  }

  /** Review the newest direct-ledger access events. */
  async QueryAccessEvents(ctx, limitText) {
    requireReviewer(ctx, 'QueryAccessEvents');
    const requested = Number(limitText || 50);
    if (!Number.isInteger(requested) || requested < 1 || requested > 500) {
      throw new Error('limit must be an integer from 1 to 500');
    }
    const events = await collect(
      await ctx.stub.getStateByPartialCompositeKey(ACCESS_EVENT_KEY, []),
      (entry) => JSON.parse(entry.value.toString())
    );
    return JSON.stringify(events.slice(-requested).reverse());
  }

  /** Record-level trail: metadata history, DIAS requests for the record, and release grants. */
  async GetAuditTrail(ctx, recordId) {
    requireReviewer(ctx, 'GetAuditTrail');
    const recordKey = ctx.stub.createCompositeKey(KEYS.RECORD, [recordId]);
    const record = await readJson(ctx, recordKey);
    if (!record) throw new Error(`record '${recordId}' does not exist`);
    const recordHistory = await collect(await ctx.stub.getHistoryForKey(recordKey), (entry) => ({
      txId: entry.txId,
      timestamp: historyTimestamp(entry.timestamp),
      value: entry.value.length > 0 ? JSON.parse(entry.value.toString()) : null,
    }));
    const requests = (await collect(
      await ctx.stub.getStateByPartialCompositeKey(KEYS.REQUEST, []),
      (entry) => JSON.parse(entry.value.toString())
    )).filter((request) => request.recordId === recordId);
    const accessDecisions = await collect(
      await ctx.stub.getStateByPartialCompositeKey(KEYS.ACCESS_DECISION, [recordId]),
      (entry) => JSON.parse(entry.value.toString())
    );
    return JSON.stringify({
      recordId,
      record,
      recordHistory,
      requests: requests.map((request) => ({
        requestId: request.requestId,
        requester: request.requester.username,
        action: request.action,
        purpose: request.purpose,
        status: request.status,
        processingPath: request.processingPath,
        submittedAtUtc: request.submittedAtUtc,
        txId: request.txId,
      })),
      accessDecisions,
      generatedAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      detail: 'Use GetRequestAuditTrail(requestId) for the complete lifecycle of one request.',
    });
  }

  /**
   * Complete lifecycle of one request: submission, dynamic authorization check,
   * auditor decision with its LLM agreement (or skip), dynamic authorization
   * creation and later changes, and the access outcome, each with the transaction
   * that committed it. Readable by reviewers and by the requester.
   */
  async GetRequestAuditTrail(ctx, requestId) {
    if (!SAFE_ID.test(requestId || '')) throw new Error('requestId has invalid format');
    const caller = getCaller(ctx);
    const requestKey = ctx.stub.createCompositeKey(KEYS.REQUEST, [requestId]);
    const request = await readJson(ctx, requestKey);
    if (!request) throw new Error(`access request '${requestId}' does not exist`);
    const reviewer = isReviewer(caller);
    const requester = request.requester.identityHash === sha256(caller.id);
    if (!reviewer && !requester) {
      throw new Error('unauthorized: the request audit trail requires a reviewer or the requester');
    }
    const lifecycle = await readRequestEvents(ctx, requestId);
    const auditorDecision = await readJson(ctx, ctx.stub.createCompositeKey(KEYS.AUDITOR_DECISION, [requestId]));
    const outcome = await readJson(ctx, ctx.stub.createCompositeKey(KEYS.OUTCOME, [requestId]));

    const related = [
      ['checked-by-this-request', request.dynamicAuthorizationCheck.authorizationId],
      ['created-by-this-request', request.createdAuthorizationId],
    ].filter(([, id]) => Boolean(id));
    const dynamicAuthorizations = [];
    for (const [relation, authorizationId] of related) {
      const key = ctx.stub.createCompositeKey(AUTHORIZATION_KEY, [authorizationId]);
      dynamicAuthorizations.push({
        relation,
        authorization: await readJson(ctx, key),
        events: await readAuthorizationEvents(ctx, authorizationId),
        keyHistory: await keyHistory(ctx, key),
      });
    }

    return JSON.stringify({
      requestId,
      viewer: reviewer ? 'reviewer' : 'requester',
      summary: summarize(request, auditorDecision, outcome),
      request,
      lifecycle,
      transactions: transactionsOf(lifecycle),
      auditorDecision,
      accessOutcome: outcome,
      dynamicAuthorizations,
      requestKeyHistory: await keyHistory(ctx, requestKey),
      provenanceSource: 'Hyperledger Fabric world state and key history',
      generatedAtUtc: ctx.stub.getDateTimestamp().toISOString(),
    });
  }
}

module.exports = AuditContract;
module.exports.REVIEWER_MSPS = REVIEWER_MSPS;
module.exports.REVIEWER_ROLES = REVIEWER_ROLES;
