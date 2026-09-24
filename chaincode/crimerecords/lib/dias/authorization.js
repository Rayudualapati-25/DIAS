'use strict';

/**
 * DIAS dynamic (reusable) authorization with exact-record scope.
 *
 * Created only when an auditor's FORCE_ALLOW did not agree with the LLM
 * recommendation shown to the auditor, which means the LLM recommended DENY. The
 * LLM itself runs in the application backend and is never written to the ledger.
 * A later request reuses the authorization only when the stable requester
 * identity, the exact record and case, the action, and the purpose are identical;
 * the verified request facts are unchanged since approval; the authorization is
 * active; and it has not expired. Matching is exact and deterministic: no
 * similarity, no model, and no retrieval.
 */

const { SAFE_ID, hashObject } = require('../util/validate');
const { verifiedRequestHash } = require('./verifiedRequest');

const AUTHORIZATION_SCHEMA_VERSION = 'dias-dynamic-authorization-v2';
const SCOPE_VERSION = 'dias-authorization-scope-exact-record-v1';
const AUTHORIZATION_KEY = 'diasAuthorization';
const AUTHORIZATION_SCOPE_KEY = 'diasAuthorizationScope';

const AUTHORIZATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
  SUPERSEDED: 'superseded',
});

const MATCH_OUTCOME = Object.freeze({
  MATCH: 'MATCH',
  NO_AUTHORIZATION: 'NO_AUTHORIZATION',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
  SUPERSEDED: 'SUPERSEDED',
  CONDITIONS_CHANGED: 'CONDITIONS_CHANGED',
});

const stableUserId = (mspId, enrollmentId) => `${mspId}::${enrollmentId}`;
const authorizationIdFor = (txId) => `AUTH-${String(txId).slice(0, 16)}`;

function buildScope({ mspId, enrollmentId, recordId, caseId, action, purpose }) {
  return {
    scopeVersion: SCOPE_VERSION,
    stableUserId: stableUserId(mspId, enrollmentId),
    recordId,
    caseId,
    action,
    purpose,
  };
}

const hashScope = (scope) => hashObject(scope);

function normalizeValidUntil(value, timestamp) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('validUntilUtc must be an ISO-8601 date-time');
  }
  const iso = parsed.toISOString();
  if (iso <= timestamp) throw new Error('validUntilUtc must be later than the decision time');
  return iso;
}

function assertSafeIds(ids) {
  for (const [field, value] of Object.entries(ids)) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
      throw new Error(`${field} has invalid format`);
    }
  }
}

/**
 * The only authorization origin DIAS accepts: an auditor FORCE_ALLOW that did not
 * agree with the LLM, which had recommended DENY.
 */
function createAuthorization({
  txId, timestamp, auditor, scope, verifiedRequest, originatingRequestId,
  auditorDecision, validUntilUtc, previous,
}) {
  if (auditorDecision.decision !== 'FORCE_ALLOW') {
    throw new Error('a dynamic authorization requires an auditor FORCE_ALLOW decision');
  }
  if (auditorDecision.llmAgreement !== 'NOT_AGREED') {
    throw new Error('a dynamic authorization requires a FORCE_ALLOW that did not agree with an LLM DENY');
  }
  assertSafeIds({
    originatingRequestId,
    auditorDecisionId: auditorDecision.auditorDecisionId,
    txId,
  });
  if (!auditor || !auditor.username || !auditor.mspId || !auditor.role || !auditor.identityHash) {
    throw new Error('the creating auditor identity is incomplete');
  }
  return {
    docType: AUTHORIZATION_KEY,
    schemaVersion: AUTHORIZATION_SCHEMA_VERSION,
    authorizationId: authorizationIdFor(txId),
    generation: previous ? previous.generation + 1 : 1,
    stateVersion: 1,
    status: AUTHORIZATION_STATUS.ACTIVE,
    scope,
    scopeHash: hashScope(scope),
    conditions: verifiedRequest,
    conditionsHash: verifiedRequestHash(verifiedRequest),
    originatingRequestId,
    auditorDecision: {
      auditorDecisionId: auditorDecision.auditorDecisionId,
      decision: auditorDecision.decision,
      llmAgreement: auditorDecision.llmAgreement,
    },
    createdBy: auditor,
    createdAtUtc: timestamp,
    creationTxId: txId,
    validUntilUtc: normalizeValidUntil(validUntilUtc, timestamp),
    supersedesAuthorizationId: previous ? previous.authorizationId : null,
    supersededByAuthorizationId: null,
    revokedBy: null,
    revokedAtUtc: null,
    revocationTxId: null,
    revocationReason: null,
    expiredAtUtc: null,
    expiryTxId: null,
  };
}

/** Compare a stored authorization with a new request. Pure; performs no writes. */
function matchAuthorization(authorization, { scopeHash, conditionsHash, timestamp }) {
  if (!authorization || authorization.schemaVersion !== AUTHORIZATION_SCHEMA_VERSION
      || authorization.scopeHash !== scopeHash) {
    return { outcome: MATCH_OUTCOME.NO_AUTHORIZATION, authorizationId: null };
  }
  const reference = {
    authorizationId: authorization.authorizationId,
    generation: authorization.generation,
    stateVersion: authorization.stateVersion,
    status: authorization.status,
  };
  if (authorization.status === AUTHORIZATION_STATUS.REVOKED) {
    return { outcome: MATCH_OUTCOME.REVOKED, ...reference };
  }
  if (authorization.status === AUTHORIZATION_STATUS.SUPERSEDED) {
    return { outcome: MATCH_OUTCOME.SUPERSEDED, ...reference };
  }
  const expired = authorization.status === AUTHORIZATION_STATUS.EXPIRED
    || (authorization.validUntilUtc !== null && timestamp >= authorization.validUntilUtc);
  if (expired) {
    return {
      outcome: MATCH_OUTCOME.EXPIRED,
      ...reference,
      needsExpiryTransition: authorization.status === AUTHORIZATION_STATUS.ACTIVE,
    };
  }
  if (authorization.conditionsHash !== conditionsHash) {
    return { outcome: MATCH_OUTCOME.CONDITIONS_CHANGED, ...reference };
  }
  return { outcome: MATCH_OUTCOME.MATCH, ...reference };
}

function transition(authorization, fields) {
  return { ...authorization, ...fields, stateVersion: authorization.stateVersion + 1 };
}

function revokeAuthorization(authorization, { revokedBy, timestamp, txId, reason }) {
  if (authorization.status !== AUTHORIZATION_STATUS.ACTIVE) {
    throw new Error(`dynamic authorization '${authorization.authorizationId}' is not active`);
  }
  return transition(authorization, {
    status: AUTHORIZATION_STATUS.REVOKED,
    revokedBy,
    revokedAtUtc: timestamp,
    revocationTxId: txId,
    revocationReason: typeof reason === 'string' && reason.length > 0 ? reason.slice(0, 500) : null,
  });
}

function expireAuthorization(authorization, { timestamp, txId }) {
  return transition(authorization, {
    status: AUTHORIZATION_STATUS.EXPIRED, expiredAtUtc: timestamp, expiryTxId: txId,
  });
}

function supersedeAuthorization(authorization, { supersededByAuthorizationId }) {
  return transition(authorization, {
    status: AUTHORIZATION_STATUS.SUPERSEDED, supersededByAuthorizationId,
  });
}

module.exports = {
  AUTHORIZATION_KEY,
  AUTHORIZATION_SCHEMA_VERSION,
  AUTHORIZATION_SCOPE_KEY,
  AUTHORIZATION_STATUS,
  MATCH_OUTCOME,
  SCOPE_VERSION,
  authorizationIdFor,
  buildScope,
  createAuthorization,
  expireAuthorization,
  hashScope,
  matchAuthorization,
  revokeAuthorization,
  stableUserId,
  supersedeAuthorization,
};
