'use strict';

/**
 * AccessContract — the DIAS access-request workflow (contract v2).
 *
 * 1. CreateAccessRequest (requester) commits who asked for which record, with the
 *    action and purpose, and in the same transaction checks the exact dynamic
 *    authorization for it. A match grants access without auditor review; a miss
 *    waits for the auditor.
 * 2. SubmitAuditorDecision (AuditMSP district head) commits FORCE_ALLOW or
 *    FORCE_DENY together with the LLM recommendation the auditor was shown:
 *    ALLOW, DENY, or UNAVAILABLE when the backend had no recommendation to show.
 *    The LLM runs in the application backend, but its recommendation is
 *    committed here, so the ledger records what was recommended as well as what
 *    was decided. Agreement is derived from the two, never supplied. A
 *    FORCE_ALLOW over an LLM DENY creates an exact-record dynamic authorization.
 *    The access outcome is recorded last.
 *
 *    Only the recommendation value is committed. Its free-text reason, its
 *    reason code and its model provenance stay off the ledger.
 *
 * Every stage is an ordered lifecycle event under the request ID. This contract
 * never evaluates governance policy.
 */

const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const {
  SAFE_ID, SHA256_HEX, hashObject, sha256, validateAllowList,
} = require('./util/validate');
const { putJson } = require('./util/state');
const { requireActiveDistrictHead } = require('./dias/auditorAuthority');
const { ACTIONS, PURPOSES, DISTRICT_HEAD_ROLES } = require('./policy/policyV1');
const KEYS = require('./dias/keys');
const { isReviewer, redactDecisionLogEntry, withheldCommitment } = require('./dias/visibility');
const {
  EVENT, actorFrom, appendAuthorizationEvents, appendRequestEvents, emitLifecycle,
  readAuthorizationEvents,
} = require('./dias/lifecycle');
const {
  AUTHORIZATION_KEY, AUTHORIZATION_SCOPE_KEY, AUTHORIZATION_STATUS, MATCH_OUTCOME,
  buildScope, createAuthorization, expireAuthorization, hashScope, matchAuthorization,
  revokeAuthorization, stableUserId, supersedeAuthorization,
} = require('./dias/authorization');
const {
  VERIFIED_REQUEST_SCHEMA_VERSION, buildVerifiedRequest, verifiedRequestHash,
} = require('./dias/verifiedRequest');
const {
  REQUESTER_CLAIMS_SCHEMA_VERSION, buildRequesterClaims, requesterClaimsHash,
} = require('./dias/requesterClaims');
const { readParameters, reviewDeadline } = require('./dias/parameters');
const {
  isBoundTo, policyBinding, readActivePolicy, requireActivePolicy,
} = require('./dias/policyRegistry');
const { assertDigest } = require('./dias/commitments');
const {
  COMMITMENT_KEY, COMMITMENT_SCHEMA_VERSION, SIGNER_KEY, bindingMismatch, parseCommitmentInput,
  provenancePayload, recommendationOf, sameCommitment, verifyProvenance,
} = require('./dias/recommendationCommitment');

const REQUEST_SCHEMA_VERSION = 'dias-access-request-v3';
const AUDITOR_DECISION_SCHEMA_VERSION = 'dias-auditor-decision-v3';
const OUTCOME_SCHEMA_VERSION = 'dias-access-outcome-v3';

const REQUEST_STATUS = Object.freeze({
  AWAITING_AUDITOR: 'awaiting-auditor',
  GRANTED: 'granted',
  DENIED: 'denied',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});
/** The access-decision index status and authority for each outcome and basis. */
const OUTCOME_STATUS = Object.freeze({
  GRANTED: 'granted', DENIED: 'denied', EXPIRED: 'expired', CANCELLED: 'cancelled',
});
const DECISION_AUTHORITY = Object.freeze({
  DYNAMIC_AUTHORIZATION: 'dynamic-authorization',
  AUDITOR_DECISION: 'auditor',
  REVIEW_DEADLINE_PASSED: 'review-deadline',
  POLICY_VERSION_CHANGED: 'policy-change',
  REQUESTER_CANCELLED: 'requester',
});
const AUDITOR_DECISIONS = Object.freeze(['FORCE_ALLOW', 'FORCE_DENY']);
const LLM_AGREEMENT = Object.freeze({
  AGREED: 'AGREED',
  NOT_AGREED: 'NOT_AGREED',
  NO_RECOMMENDATION: 'NO_RECOMMENDATION',
});
/** Agreements whose decision must carry the auditor note digest h_N (design §7). */
const NOTE_REQUIRED = Object.freeze([LLM_AGREEMENT.NOT_AGREED, LLM_AGREEMENT.NO_RECOMMENDATION]);
/**
 * The recommendation value a decision is compared with, read from κ. UNAVAILABLE
 * covers a failed or missing generation; the specific status is kept beside it.
 */
const LLM_RECOMMENDATION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  UNAVAILABLE: 'UNAVAILABLE',
});
const MAX_REASON = 500;
const ORG_TO_MSP = Object.freeze({
  police: MSP.POLICE,
  forensics: MSP.FORENSICS,
  prosecution: MSP.PROSECUTION,
  court: MSP.COURT,
  audit: MSP.AUDIT,
});

/**
 * The requester's input. `action` and `purpose` are what is being asked for and
 * enter the verified context; `emergencyDeclared` is the requester's own
 * statement and is recorded as a claim, outside it (plan step 5).
 * `justificationHash` is h_J: the justification text stays off-chain and only
 * its digest is committed (plan step 9, design §4).
 */
const REQUEST_INPUT_SCHEMA = Object.freeze({
  action: { type: 'string', required: true, enum: [...ACTIONS] },
  purpose: { type: 'string', required: true, enum: [...PURPOSES] },
  emergencyDeclared: { type: 'boolean', required: false, default: false },
  justificationHash: { type: 'string', required: true, pattern: SHA256_HEX },
});

const shortTxId = (ctx) => ctx.stub.getTxID().slice(0, 16);
const token = (value) => String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_');

/**
 * Agreement is derived here from the committed recommendation and the auditor
 * decision, so the ledger can never hold an agreement value that contradicts the
 * recommendation recorded beside it.
 */
function agreementFor(decision, llmRecommendation) {
  if (llmRecommendation === LLM_RECOMMENDATION.UNAVAILABLE) {
    return LLM_AGREEMENT.NO_RECOMMENDATION;
  }
  const auditorAllows = decision === 'FORCE_ALLOW';
  const llmAllows = llmRecommendation === LLM_RECOMMENDATION.ALLOW;
  return auditorAllows === llmAllows ? LLM_AGREEMENT.AGREED : LLM_AGREEMENT.NOT_AGREED;
}

function parseJsonArgument(text, label) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function boundedReason(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_REASON) {
    throw new Error(`${label} must be a string of at most ${MAX_REASON} characters`);
  }
  return value.trim().length === 0 ? null : value;
}

function mergedCredentialStatus(profileStatus, certificateStatus) {
  if (profileStatus !== 'active') return profileStatus || 'inactive';
  if (certificateStatus !== 'active') return certificateStatus || 'inactive';
  return 'active';
}

function subjectFromProfile(mspId, profile, credentialStatus) {
  return {
    mspId,
    organization: profile.org,
    role: profile.role,
    rank: profile.rank,
    station: profile.station,
    jurisdiction: profile.jurisdiction,
    clearance: profile.clearance,
    credentialStatus,
  };
}

function historyTimestamp(timestamp) {
  if (!timestamp) return null;
  const seconds = typeof timestamp.seconds?.toNumber === 'function'
    ? timestamp.seconds.toNumber() : Number(timestamp.seconds);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000 + Math.round((timestamp.nanos || 0) / 1e6)).toISOString();
}

class AccessContract extends Contract {
  constructor() {
    super('AccessContract');
  }

  _key(ctx, type, ...parts) {
    return ctx.stub.createCompositeKey(type, parts);
  }

  async _read(ctx, key) {
    const data = await ctx.stub.getState(key);
    return data && data.length > 0 ? JSON.parse(data.toString()) : null;
  }

  async _mustRead(ctx, key, label) {
    const value = await this._read(ctx, key);
    if (!value) throw new Error(`${label} does not exist`);
    return value;
  }

  async _getRequest(ctx, requestId) {
    if (!SAFE_ID.test(requestId || '')) throw new Error('requestId has invalid format');
    return this._mustRead(ctx, this._key(ctx, KEYS.REQUEST, requestId), `access request '${requestId}'`);
  }

  _requireStatus(request, expected) {
    if (request.status !== expected) {
      throw new Error(`access request '${request.requestId}' is not ${expected} (status: ${request.status})`);
    }
  }

  /** A pending request accepts no decision or commitment once its deadline has passed. */
  _requireBeforeDeadline(request, timestamp) {
    if (request.reviewDeadlineUtc && timestamp >= request.reviewDeadlineUtc) {
      throw new Error(
        `DIAS_REQUEST_EXPIRED: the review deadline ${request.reviewDeadlineUtc} of access request `
        + `'${request.requestId}' has passed; it must be expired and requested again`
      );
    }
  }

  _requireAuditor(ctx, action) {
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.AUDIT], action);
    requireRole(caller, [...DISTRICT_HEAD_ROLES], action);
    return caller;
  }

  async _assignedToCase(ctx, caseId, enrollmentId, required) {
    const caseAsset = await this._read(ctx, this._key(ctx, KEYS.CASE, caseId));
    if (!caseAsset) {
      if (required) throw new Error(`case '${caseId}' does not exist`);
      return false;
    }
    return Array.isArray(caseAsset.assignedUsers) && caseAsset.assignedUsers.includes(enrollmentId);
  }

  /** Certificate-bound requester facts from the UserProfile and current Case assignment. */
  async _requesterProfile(ctx, caller, record) {
    if (!caller.enrollmentId) {
      throw new Error('unauthorized: caller certificate has no enrollment identity');
    }
    const profile = await this._read(ctx, this._key(ctx, KEYS.USER, caller.enrollmentId));
    if (!profile) throw new Error('unauthorized: caller has no UserProfile on the ledger');
    if (profile.fabricUser !== caller.enrollmentId
        || ORG_TO_MSP[profile.org] !== caller.mspId
        || profile.role !== caller.role) {
      throw new Error('unauthorized: certificate does not match the UserProfile');
    }
    for (const attribute of ['rank', 'station', 'jurisdiction', 'clearance']) {
      if (profile[attribute] && caller[attribute] !== profile[attribute]) {
        throw new Error(`unauthorized: certificate ${attribute} does not match UserProfile`);
      }
    }
    const assigned = await this._assignedToCase(ctx, record.caseId, caller.enrollmentId, true);
    return {
      profile,
      assigned,
      credentialStatus: mergedCredentialStatus(profile.credentialStatus, caller.credentialStatus),
    };
  }

  /** Rebuild a stored request's verified facts from current ledger state. */
  async _currentVerifiedRequest(ctx, request) {
    const record = await this._mustRead(
      ctx, this._key(ctx, KEYS.RECORD, request.recordId), `record '${request.recordId}'`
    );
    const profile = await this._read(ctx, this._key(ctx, KEYS.USER, request.requester.username));
    if (!profile) throw new Error('requester no longer has a UserProfile on the ledger');
    const assigned = await this._assignedToCase(ctx, record.caseId, request.requester.username, false);
    const credentialStatus = mergedCredentialStatus(
      profile.credentialStatus, request.committedCertificateCredentialStatus
    );
    const verifiedRequest = buildVerifiedRequest({
      subject: subjectFromProfile(request.requester.mspId, profile, credentialStatus),
      record,
      requestContext: {
        action: request.verifiedRequest.request.action,
        purpose: request.verifiedRequest.request.purpose,
      },
      assignedToRequestedCase: assigned,
    });
    return { verifiedRequest, verifiedRequestHash: verifiedRequestHash(verifiedRequest) };
  }

  async _assertFactsUnchanged(ctx, request) {
    const current = await this._currentVerifiedRequest(ctx, request);
    if (current.verifiedRequestHash !== request.verifiedRequestHash) {
      throw new Error('verified request facts changed since the request was submitted; submit a new request');
    }
  }

  async _checkAuthorization(ctx, scopeHash, conditionsHash, timestamp, policyHash) {
    const index = await this._read(ctx, this._key(ctx, AUTHORIZATION_SCOPE_KEY, scopeHash));
    const authorization = index
      ? await this._read(ctx, this._key(ctx, AUTHORIZATION_KEY, index.authorizationId)) : null;
    return {
      authorization,
      match: matchAuthorization(authorization, { scopeHash, conditionsHash, timestamp, policyHash }),
    };
  }

  /** Only a request written by this contract version can be decided. */
  _requireCurrentSchema(request) {
    if (request.schemaVersion !== REQUEST_SCHEMA_VERSION || !request.policyHash) {
      throw new Error(
        `DIAS_LEGACY_RECORD: access request '${request.requestId}' has schema `
        + `'${request.schemaVersion}' and cannot be decided by this contract version; request access again`
      );
    }
  }

  /** The request's policy must still be the active one. */
  async _requireCurrentPolicy(ctx, request) {
    const active = await requireActivePolicy(ctx);
    if (!isBoundTo(request, active)) {
      throw new Error(
        `DIAS_STALE_POLICY: access request '${request.requestId}' was made under policy `
        + `'${request.policyVersion}', but '${active.policyVersion}' is active; it must be requested again`
      );
    }
    return active;
  }

  async _writeOutcome(ctx, {
    request, outcome, basis, auditorDecisionId = null, llmRecommendation = null,
    matchedAuthorization = null, createdAuthorizationId = null, timestamp,
  }) {
    const txId = ctx.stub.getTxID();
    const outcomeId = `OUTCOME-${shortTxId(ctx)}`;
    const record = {
      docType: KEYS.OUTCOME,
      schemaVersion: OUTCOME_SCHEMA_VERSION,
      outcomeId,
      requestId: request.requestId,
      requester: request.requester,
      recordId: request.recordId,
      caseId: request.caseId,
      action: request.action,
      purpose: request.purpose,
      outcome,
      basis,
      policyVersion: request.policyVersion,
      policyHash: request.policyHash,
      auditorDecisionId,
      llmRecommendation,
      authorizationId: matchedAuthorization ? matchedAuthorization.authorizationId : null,
      authorizationGeneration: matchedAuthorization ? matchedAuthorization.generation : null,
      originatingRequestId: matchedAuthorization ? matchedAuthorization.originatingRequestId : null,
      originatingAuditorDecisionId: matchedAuthorization
        ? matchedAuthorization.auditorDecision.auditorDecisionId : null,
      createdAuthorizationId,
      recordedAtUtc: timestamp,
      txId,
    };
    await putJson(ctx, this._key(ctx, KEYS.OUTCOME, request.requestId), record);
    const granted = outcome === 'GRANTED';
    await putJson(ctx, this._key(ctx, KEYS.ACCESS_DECISION, request.recordId, outcomeId), {
      docType: KEYS.ACCESS_DECISION,
      decisionId: outcomeId,
      requestId: request.requestId,
      recordId: request.recordId,
      caseId: request.caseId,
      action: request.action,
      purpose: request.purpose,
      decision: granted ? 'allow' : 'deny',
      status: OUTCOME_STATUS[outcome],
      decisionAuthority: DECISION_AUTHORITY[basis],
      policyVersion: request.policyVersion,
      policyHash: request.policyHash,
      authorizationId: record.authorizationId,
      auditorDecisionId,
      llmRecommendation,
      subject: {
        username: request.requester.username,
        identityHash: request.requester.identityHash,
        mspId: request.requester.mspId,
        role: request.requester.role,
      },
      createdAtUtc: timestamp,
      txId,
    });
    return {
      record,
      event: {
        type: EVENT.ACCESS_OUTCOME_RECORDED,
        data: {
          outcomeId,
          outcome,
          basis,
          auditorDecisionId,
          llmRecommendation,
          authorizationId: record.authorizationId,
          createdAuthorizationId,
          recordId: request.recordId,
          action: request.action,
          stableUserId: request.requester.stableUserId,
        },
      },
    };
  }

  /**
   * Step 1 — the requester submits a request. The request log records who asked
   * for which record, with the action and purpose, and the exact dynamic
   * authorization is checked against committed state in the same transaction.
   */
  async CreateAccessRequest(ctx, recordId, requestJson) {
    if (!SAFE_ID.test(recordId || '')) throw new Error('recordId has invalid format');
    const caller = getCaller(ctx);
    if (caller.role === null) throw new Error('unauthorized: caller identity has no role attribute');
    const input = validateAllowList(
      parseJsonArgument(requestJson, 'access request'), REQUEST_INPUT_SCHEMA, 'access request'
    );
    const record = await this._mustRead(ctx, this._key(ctx, KEYS.RECORD, recordId), `record '${recordId}'`);
    const activePolicy = await requireActivePolicy(ctx);
    const { profile, assigned, credentialStatus } = await this._requesterProfile(ctx, caller, record);
    const verifiedRequest = buildVerifiedRequest({
      subject: subjectFromProfile(caller.mspId, profile, credentialStatus),
      record,
      requestContext: { action: input.action, purpose: input.purpose },
      assignedToRequestedCase: assigned,
    });
    const verifiedHash = verifiedRequestHash(verifiedRequest);
    const requesterClaims = buildRequesterClaims({ emergencyDeclared: input.emergencyDeclared });
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const requestId = `REQ-${shortTxId(ctx)}`;
    const parameters = await readParameters(ctx);
    const requestKey = this._key(ctx, KEYS.REQUEST, requestId);
    if (await this._read(ctx, requestKey)) throw new Error(`access request '${requestId}' already exists`);

    const identityHash = sha256(caller.id);
    const actor = actorFrom(caller, identityHash);
    const scope = buildScope({
      mspId: caller.mspId,
      enrollmentId: caller.enrollmentId,
      recordId,
      caseId: record.caseId,
      action: input.action,
      purpose: input.purpose,
    });
    const scopeHash = hashScope(scope);
    const { authorization, match } = await this._checkAuthorization(
      ctx, scopeHash, verifiedHash, timestamp, activePolicy.policyHash
    );
    const matched = match.outcome === MATCH_OUTCOME.MATCH;
    const requester = {
      stableUserId: stableUserId(caller.mspId, caller.enrollmentId),
      username: caller.enrollmentId,
      mspId: caller.mspId,
      organization: profile.org,
      role: caller.role,
      identityHash,
    };
    const dynamicAuthorizationCheck = {
      outcome: match.outcome,
      matched,
      authorizationId: match.authorizationId || null,
      generation: match.generation === undefined ? null : match.generation,
      stateVersion: match.stateVersion === undefined ? null : match.stateVersion,
      status: match.status || null,
      scopeHash,
      conditionsHash: verifiedHash,
      policyVersion: activePolicy.policyVersion,
      policyHash: activePolicy.policyHash,
      checkedAtUtc: timestamp,
    };
    const request = {
      docType: KEYS.REQUEST,
      schemaVersion: REQUEST_SCHEMA_VERSION,
      requestId,
      txId,
      submittedAtUtc: timestamp,
      requester,
      recordId,
      caseId: record.caseId,
      action: input.action,
      purpose: input.purpose,
      ...policyBinding(activePolicy),
      verifiedRequestSchemaVersion: VERIFIED_REQUEST_SCHEMA_VERSION,
      verifiedRequest,
      verifiedRequestHash: verifiedHash,
      requesterClaimsSchemaVersion: REQUESTER_CLAIMS_SCHEMA_VERSION,
      requesterClaims,
      requesterClaimsHash: requesterClaimsHash(requesterClaims),
      justificationHash: input.justificationHash,
      committedCertificateCredentialStatus: caller.credentialStatus,
      authorizationScope: scope,
      authorizationScopeHash: scopeHash,
      dynamicAuthorizationCheck,
      processingPath: matched ? 'dynamic-authorization' : 'auditor-review',
      status: matched ? REQUEST_STATUS.GRANTED : REQUEST_STATUS.AWAITING_AUDITOR,
      reviewDeadlineUtc: matched ? null : reviewDeadline(timestamp, parameters),
      auditorReviewStatus: matched ? 'SKIPPED' : 'PENDING',
      llmAgreement: null,
      auditorDecisionId: null,
      outcomeId: null,
      createdAuthorizationId: null,
      lifecycleSeq: 0,
    };
    const submitted = {
      type: EVENT.ACCESS_REQUEST_SUBMITTED,
      data: {
        requestId,
        stableUserId: requester.stableUserId,
        username: requester.username,
        organization: requester.organization,
        role: requester.role,
        mspId: requester.mspId,
        recordId,
        caseId: record.caseId,
        action: input.action,
        purpose: input.purpose,
        justificationHash: input.justificationHash,
        policyVersion: activePolicy.policyVersion,
        submittedAtUtc: timestamp,
        schemaVersion: REQUEST_SCHEMA_VERSION,
      },
    };
    const checked = {
      type: EVENT.DYNAMIC_AUTHORIZATION_CHECKED,
      data: { ...dynamicAuthorizationCheck, stateSource: 'committed world state read in this transaction' },
    };

    if (matched) {
      const outcome = await this._writeOutcome(ctx, {
        request, outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION',
        matchedAuthorization: authorization, timestamp,
      });
      const events = [
        submitted,
        checked,
        {
          type: EVENT.AUDITOR_REVIEW_SKIPPED,
          data: {
            status: 'SKIPPED',
            reason: 'ACTIVE_DYNAMIC_AUTHORIZATION',
            authorizationId: authorization.authorizationId,
            originatingRequestId: authorization.originatingRequestId,
            originatingAuditorDecisionId: authorization.auditorDecision.auditorDecisionId,
          },
        },
        outcome.event,
      ];
      const { lastSeq } = await appendRequestEvents(ctx, { requestId, lastSeq: 0, actor, events });
      const stored = { ...request, outcomeId: outcome.record.outcomeId, lifecycleSeq: lastSeq };
      await putJson(ctx, requestKey, stored);
      emitLifecycle(ctx, {
        requestId,
        recordId,
        requesterUsername: requester.username,
        stages: events.map((event) => event.type),
        nextStep: null,
        outcome: 'GRANTED',
        authorizationId: authorization.authorizationId,
      });
      return JSON.stringify(stored);
    }

    const expiryStages = match.needsExpiryTransition ? [EVENT.DYNAMIC_AUTHORIZATION_EXPIRED] : [];
    if (match.needsExpiryTransition) {
      const expired = expireAuthorization(authorization, { timestamp, txId });
      const { lastSeq } = await appendAuthorizationEvents(ctx, {
        authorizationId: authorization.authorizationId,
        lastSeq: authorization.lifecycleSeq || 0,
        actor,
        events: [{
          type: EVENT.DYNAMIC_AUTHORIZATION_EXPIRED,
          data: {
            previousStatus: authorization.status,
            previousStateVersion: authorization.stateVersion,
            newStatus: expired.status,
            newStateVersion: expired.stateVersion,
            validUntilUtc: authorization.validUntilUtc,
            detectedByRequestId: requestId,
          },
        }],
      });
      await putJson(
        ctx, this._key(ctx, AUTHORIZATION_KEY, authorization.authorizationId),
        { ...expired, lifecycleSeq: lastSeq }
      );
    }
    const events = [submitted, checked];
    const { lastSeq } = await appendRequestEvents(ctx, { requestId, lastSeq: 0, actor, events });
    const stored = { ...request, lifecycleSeq: lastSeq };
    await putJson(ctx, requestKey, stored);
    emitLifecycle(ctx, {
      requestId,
      recordId,
      requesterUsername: requester.username,
      stages: [...events.map((event) => event.type), ...expiryStages],
      nextStep: 'AUDITOR_DECISION',
    });
    return JSON.stringify(stored);
  }

  async _createAuthorization(ctx, {
    request, auditorDecisionId, decision, llmRecommendation, llmAgreement, actor,
    validUntilUtc, timestamp, txId, recommendationCommitmentId, recommendationHash,
  }) {
    const scopeKey = this._key(ctx, AUTHORIZATION_SCOPE_KEY, request.authorizationScopeHash);
    const index = await this._read(ctx, scopeKey);
    const previous = index
      ? await this._read(ctx, this._key(ctx, AUTHORIZATION_KEY, index.authorizationId)) : null;
    const created = createAuthorization({
      txId,
      timestamp,
      auditor: actor,
      scope: request.authorizationScope,
      verifiedRequest: request.verifiedRequest,
      originatingRequestId: request.requestId,
      auditorDecision: { auditorDecisionId, decision, llmRecommendation, llmAgreement },
      validUntilUtc,
      previous,
      policy: { policyVersion: request.policyVersion, policyHash: request.policyHash },
      recommendationCommitment: { recommendationCommitmentId, recommendationHash },
    });
    const supersedes = Boolean(previous)
      && [AUTHORIZATION_STATUS.ACTIVE, AUTHORIZATION_STATUS.EXPIRED].includes(previous.status);
    if (supersedes) {
      const superseded = supersedeAuthorization(previous, {
        supersededByAuthorizationId: created.authorizationId,
      });
      const { lastSeq } = await appendAuthorizationEvents(ctx, {
        authorizationId: previous.authorizationId,
        lastSeq: previous.lifecycleSeq || 0,
        actor,
        events: [{
          type: EVENT.DYNAMIC_AUTHORIZATION_SUPERSEDED,
          data: {
            previousStatus: previous.status,
            previousStateVersion: previous.stateVersion,
            newStatus: superseded.status,
            newStateVersion: superseded.stateVersion,
            supersededByAuthorizationId: created.authorizationId,
            originatingRequestId: request.requestId,
          },
        }],
      });
      await putJson(
        ctx, this._key(ctx, AUTHORIZATION_KEY, previous.authorizationId),
        { ...superseded, lifecycleSeq: lastSeq }
      );
    }
    const createdData = {
      authorizationId: created.authorizationId,
      generation: created.generation,
      stateVersion: created.stateVersion,
      status: created.status,
      scope: created.scope,
      scopeHash: created.scopeHash,
      conditionsHash: created.conditionsHash,
      policyVersion: created.policyVersion,
      policyHash: created.policyHash,
      recommendationCommitmentId: created.recommendationCommitmentId,
      recommendationHash: created.recommendationHash,
      validUntilUtc: created.validUntilUtc,
      originatingRequestId: request.requestId,
      auditorDecisionId,
      llmRecommendation,
      llmAgreement,
      supersedesAuthorizationId: created.supersedesAuthorizationId,
    };
    const { lastSeq } = await appendAuthorizationEvents(ctx, {
      authorizationId: created.authorizationId,
      lastSeq: 0,
      actor,
      events: [{ type: EVENT.DYNAMIC_AUTHORIZATION_CREATED, data: createdData }],
    });
    const stored = { ...created, lifecycleSeq: lastSeq };
    await putJson(ctx, this._key(ctx, AUTHORIZATION_KEY, created.authorizationId), stored);
    await putJson(ctx, scopeKey, {
      docType: AUTHORIZATION_SCOPE_KEY,
      scopeHash: created.scopeHash,
      authorizationId: created.authorizationId,
      updatedAtUtc: timestamp,
      txId,
    });
    return {
      authorization: stored,
      requestEvent: { type: EVENT.DYNAMIC_AUTHORIZATION_CREATED, data: createdData },
      extraStages: supersedes ? [EVENT.DYNAMIC_AUTHORIZATION_SUPERSEDED] : [],
    };
  }

  /**
   * Step 2 (pre-review) — commit the recommendation κ before any auditor review
   * (design §6). Any member identity may relay it: its authority comes from the
   * recommendation service's signature, which binds it to this request, its
   * committed hashes, its policy and this channel. One commitment per request; an
   * identical resubmission is a safe retry that writes nothing.
   */
  async CommitRecommendation(ctx, requestId, commitmentJson) {
    const caller = getCaller(ctx);
    if (caller.role === null) throw new Error('unauthorized: caller identity has no role attribute');
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    this._requireBeforeDeadline(request, ctx.stub.getDateTimestamp().toISOString());
    this._requireCurrentSchema(request);
    await this._requireCurrentPolicy(ctx, request);
    const input = parseCommitmentInput(commitmentJson);
    const mismatch = bindingMismatch(input, request);
    if (mismatch) {
      throw new Error(`DIAS_COMMITMENT_MISMATCH: ${mismatch} does not match access request '${requestId}'`);
    }
    const commitmentKey = this._key(ctx, COMMITMENT_KEY, requestId);
    const existing = await this._read(ctx, commitmentKey);
    if (existing) {
      if (sameCommitment(existing, input)) return JSON.stringify(existing);
      throw new Error(
        `DIAS_COMMITMENT_CONFLICT: access request '${requestId}' already has commitment `
        + `'${existing.commitmentId}', and a commitment is never replaced`
      );
    }
    const signer = await this._read(ctx, this._key(ctx, SIGNER_KEY, input.signerKeyId));
    if (!signer || signer.status !== 'active') {
      throw new Error(`DIAS_SIGNER_INACTIVE: '${input.signerKeyId}' is not an active recommendation signer`);
    }
    const payload = provenancePayload({ channel: ctx.stub.getChannelID(), requestId, ...input });
    if (!verifyProvenance({ publicKeyPem: signer.publicKeyPem, payload, signature: input.signature })) {
      throw new Error('DIAS_SIGNATURE_INVALID: the recommendation signature does not verify for this request');
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const actor = actorFrom(caller, sha256(caller.id));
    const commitment = {
      docType: COMMITMENT_KEY,
      schemaVersion: COMMITMENT_SCHEMA_VERSION,
      commitmentId: `KAPPA-${shortTxId(ctx)}`,
      requestId,
      ...input,
      relayedBy: actor,
      committedAtUtc: timestamp,
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, commitmentKey, commitment);
    const events = [{
      type: EVENT.RECOMMENDATION_COMMITTED,
      data: {
        commitmentId: commitment.commitmentId,
        recommendation: input.recommendation,
        generationStatus: input.generationStatus,
        recommendationHash: input.recommendationHash,
        modelVersion: input.modelVersion,
        signerKeyId: input.signerKeyId,
      },
    }];
    const { lastSeq } = await appendRequestEvents(ctx, {
      requestId, lastSeq: request.lifecycleSeq, actor, events,
    });
    await putJson(ctx, this._key(ctx, KEYS.REQUEST, requestId), {
      ...request, recommendationCommitmentId: commitment.commitmentId, lifecycleSeq: lastSeq,
    });
    emitLifecycle(ctx, {
      requestId,
      recordId: request.recordId,
      stages: [EVENT.RECOMMENDATION_COMMITTED],
      nextStep: 'AUDITOR_DECISION',
      generationStatus: input.generationStatus,
    });
    return JSON.stringify(commitment);
  }

  /**
   * Step 3 — an AuditMSP district head commits the binding decision. The
   * recommendation it is compared with is read from κ, never supplied by the
   * caller, and the contract derives the agreement (paper Eq. 3). `noteHash` is
   * h_N, the digest of the auditor's off-chain note.
   */
  async SubmitAuditorDecision(ctx, requestId, decisionText, noteHash, validUntilUtc) {
    const caller = this._requireAuditor(ctx, 'SubmitAuditorDecision');
    const decision = token(decisionText);
    if (!AUDITOR_DECISIONS.includes(decision)) {
      throw new Error('auditor decision must be one of [FORCE_ALLOW, FORCE_DENY]');
    }
    const note = noteHash === undefined || noteHash === null || noteHash === '' ? null
      : assertDigest(noteHash, 'noteHash');
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    this._requireBeforeDeadline(request, ctx.stub.getDateTimestamp().toISOString());
    this._requireCurrentSchema(request);
    await this._requireCurrentPolicy(ctx, request);
    const identityHash = sha256(caller.id);
    if (identityHash === request.requester.identityHash) {
      throw new Error('unauthorized: a requester cannot decide their own request');
    }
    const record = await this._mustRead(
      ctx, this._key(ctx, KEYS.RECORD, request.recordId), `record '${request.recordId}'`
    );
    await requireActiveDistrictHead(ctx, { action: 'SubmitAuditorDecision', record, caller });
    await this._assertFactsUnchanged(ctx, request);
    const committed = recommendationOf(await this._read(ctx, this._key(ctx, COMMITMENT_KEY, requestId)));
    const { llmRecommendation, generationStatus, recommendationCommitmentId, recommendationHash } = committed;
    const llmAgreement = agreementFor(decision, llmRecommendation);
    // h_N: a decision that departs from the committed recommendation, or has none
    // to follow, must commit to the auditor's off-chain note (design §7).
    if (NOTE_REQUIRED.includes(llmAgreement) && note === null) {
      throw new Error(`DIAS_NOTE_REQUIRED: a decision recorded as ${llmAgreement} must carry the digest `
        + 'of the auditor note (noteHash)');
    }
    const createsAuthorization = decision === 'FORCE_ALLOW' && llmAgreement === LLM_AGREEMENT.NOT_AGREED;
    if (!createsAuthorization && validUntilUtc) {
      throw new Error('validUntilUtc applies only when a dynamic authorization is created');
    }
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const auditorDecisionId = `AUDIT-${shortTxId(ctx)}`;
    const actor = actorFrom(caller, identityHash);
    const authorization = createsAuthorization
      ? await this._createAuthorization(ctx, {
        request, auditorDecisionId, decision, llmRecommendation, llmAgreement, actor,
        validUntilUtc, timestamp, txId, recommendationCommitmentId, recommendationHash,
      })
      : null;
    const createdAuthorizationId = authorization ? authorization.authorization.authorizationId : null;
    const auditorBase = {
      docType: KEYS.AUDITOR_DECISION,
      schemaVersion: AUDITOR_DECISION_SCHEMA_VERSION,
      auditorDecisionId,
      requestId,
      recordId: request.recordId,
      auditor: { ...actor, stableUserId: stableUserId(caller.mspId, caller.enrollmentId) },
      decision,
      llmRecommendation,
      generationStatus,
      llmAgreement,
      recommendationCommitmentId,
      recommendationHash,
      noteHash: note,
      verifiedRequestHash: request.verifiedRequestHash,
      policyVersion: request.policyVersion,
      policyHash: request.policyHash,
      authorizationCreated: createsAuthorization,
      createdAuthorizationId,
      decidedAtUtc: timestamp,
      txId,
    };
    const auditorDecision = { ...auditorBase, auditorDecisionHash: hashObject(auditorBase) };
    await putJson(ctx, this._key(ctx, KEYS.AUDITOR_DECISION, requestId), auditorDecision);
    const outcome = await this._writeOutcome(ctx, {
      request,
      outcome: decision === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED',
      basis: 'AUDITOR_DECISION',
      auditorDecisionId,
      llmRecommendation,
      createdAuthorizationId,
      timestamp,
    });
    const events = [
      {
        type: EVENT.AUDITOR_DECISION_RECORDED,
        data: {
          auditorDecisionId,
          auditorStableUserId: auditorDecision.auditor.stableUserId,
          auditorUsername: caller.enrollmentId,
          auditorMsp: caller.mspId,
          auditorRole: caller.role,
          decision,
          noteHash: note,
          verifiedRequestHash: request.verifiedRequestHash,
          auditorDecisionHash: auditorDecision.auditorDecisionHash,
        },
      },
      {
        type: EVENT.AGREEMENT_DERIVED,
        data: {
          decision,
          recommendationCommitmentId,
          llmRecommendation,
          generationStatus,
          llmAgreement,
        },
      },
      ...(authorization ? [authorization.requestEvent] : []),
      outcome.event,
    ];
    const { lastSeq } = await appendRequestEvents(ctx, {
      requestId, lastSeq: request.lifecycleSeq, actor, events,
    });
    await putJson(ctx, this._key(ctx, KEYS.REQUEST, requestId), {
      ...request,
      status: decision === 'FORCE_ALLOW' ? REQUEST_STATUS.GRANTED : REQUEST_STATUS.DENIED,
      auditorReviewStatus: decision,
      llmRecommendation,
      generationStatus,
      llmAgreement,
      auditorDecisionId,
      outcomeId: outcome.record.outcomeId,
      createdAuthorizationId,
      lifecycleSeq: lastSeq,
    });
    emitLifecycle(ctx, {
      requestId,
      recordId: request.recordId,
      stages: [...events.map((event) => event.type), ...(authorization ? authorization.extraStages : [])],
      nextStep: null,
      outcome: outcome.record.outcome,
      llmRecommendation,
      llmAgreement,
      createdAuthorizationId,
    });
    return JSON.stringify({
      auditorDecision,
      accessOutcome: outcome.record,
      dynamicAuthorization: authorization ? authorization.authorization : null,
    });
  }

  /**
   * Close a pending request without an auditor decision: its outcome, the
   * access-decision index entry and the lifecycle events are written together.
   */
  async _closePending(ctx, request, { caller, outcome, basis, eventType, eventData, status, reviewStatus }) {
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const actor = actorFrom(caller, sha256(caller.id));
    const written = await this._writeOutcome(ctx, { request, outcome, basis, timestamp });
    const events = [{ type: eventType, data: eventData }, written.event];
    const { lastSeq } = await appendRequestEvents(ctx, {
      requestId: request.requestId, lastSeq: request.lifecycleSeq, actor, events,
    });
    const stored = {
      ...request,
      status,
      auditorReviewStatus: reviewStatus,
      outcomeId: written.record.outcomeId,
      lifecycleSeq: lastSeq,
    };
    await putJson(ctx, this._key(ctx, KEYS.REQUEST, request.requestId), stored);
    emitLifecycle(ctx, {
      requestId: request.requestId,
      recordId: request.recordId,
      stages: events.map((event) => event.type),
      nextStep: null,
      outcome,
    });
    return JSON.stringify({ request: stored, accessOutcome: written.record });
  }

  /**
   * Record that a pending request passed its review deadline (design §8). Any
   * member identity may submit it — the backend's sweeper does — because the
   * contract decides from committed state whether the request is due.
   */
  async ExpirePendingRequest(ctx, requestId) {
    const caller = getCaller(ctx);
    if (caller.role === null) throw new Error('unauthorized: caller identity has no role attribute');
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const deadlinePassed = Boolean(request.reviewDeadlineUtc) && timestamp >= request.reviewDeadlineUtc;
    // A request made under a policy that is no longer active can never be
    // decided (design §5), so it may be closed at once.
    const active = await readActivePolicy(ctx);
    const policyChanged = Boolean(active) && !isBoundTo(request, active);
    if (!deadlinePassed && !policyChanged) {
      throw new Error(
        `access request '${requestId}' is not due to expire until ${request.reviewDeadlineUtc || 'never'}`
      );
    }
    const basis = deadlinePassed ? 'REVIEW_DEADLINE_PASSED' : 'POLICY_VERSION_CHANGED';
    return this._closePending(ctx, request, {
      caller,
      outcome: 'EXPIRED',
      basis,
      eventType: EVENT.REQUEST_EXPIRED,
      eventData: {
        reviewDeadlineUtc: request.reviewDeadlineUtc,
        basis,
        requestPolicyVersion: request.policyVersion || null,
        activePolicyVersion: active ? active.policyVersion : null,
      },
      status: REQUEST_STATUS.EXPIRED,
      reviewStatus: 'EXPIRED',
    });
  }

  /** The requester withdraws a request that is still waiting for review. */
  async CancelAccessRequest(ctx, requestId) {
    const caller = getCaller(ctx);
    const request = await this._getRequest(ctx, requestId);
    if (request.requester.identityHash !== sha256(caller.id)) {
      throw new Error('unauthorized: only the requester can cancel this request');
    }
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    return this._closePending(ctx, request, {
      caller,
      outcome: 'CANCELLED',
      basis: 'REQUESTER_CANCELLED',
      eventType: EVENT.REQUEST_CANCELLED,
      eventData: { cancelledBy: request.requester.stableUserId },
      status: REQUEST_STATUS.CANCELLED,
      reviewStatus: 'CANCELLED',
    });
  }

  /** Explicit, auditable revocation. FORCE_DENY never revokes anything implicitly. */
  async RevokeDynamicAuthorization(ctx, authorizationId, reasonText) {
    const caller = this._requireAuditor(ctx, 'RevokeDynamicAuthorization');
    if (!SAFE_ID.test(authorizationId || '')) throw new Error('authorizationId has invalid format');
    const reason = boundedReason(reasonText, 'revocation reason');
    if (reason === null) throw new Error('a revocation reason is required');
    const key = this._key(ctx, AUTHORIZATION_KEY, authorizationId);
    const authorization = await this._mustRead(ctx, key, `dynamic authorization '${authorizationId}'`);
    const record = await this._mustRead(
      ctx, this._key(ctx, KEYS.RECORD, authorization.scope.recordId), `record '${authorization.scope.recordId}'`
    );
    await requireActiveDistrictHead(ctx, { action: 'RevokeDynamicAuthorization', record, caller });
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const actor = actorFrom(caller, sha256(caller.id));
    const revoked = revokeAuthorization(authorization, { revokedBy: actor, timestamp, txId, reason });
    const { lastSeq } = await appendAuthorizationEvents(ctx, {
      authorizationId,
      lastSeq: authorization.lifecycleSeq || 0,
      actor,
      events: [{
        type: EVENT.DYNAMIC_AUTHORIZATION_REVOKED,
        data: {
          previousStatus: authorization.status,
          previousStateVersion: authorization.stateVersion,
          newStatus: revoked.status,
          newStateVersion: revoked.stateVersion,
          reason,
          originatingRequestId: authorization.originatingRequestId,
        },
      }],
    });
    const stored = { ...revoked, lifecycleSeq: lastSeq };
    await putJson(ctx, key, stored);
    emitLifecycle(ctx, {
      authorizationId,
      originatingRequestId: authorization.originatingRequestId,
      stages: [EVENT.DYNAMIC_AUTHORIZATION_REVOKED],
      nextStep: null,
    });
    return JSON.stringify(stored);
  }

  async GetRequest(ctx, requestId) {
    const caller = getCaller(ctx);
    const request = await this._getRequest(ctx, requestId);
    const ownsRequest = request.requester.identityHash === sha256(caller.id);
    const isAuditor = caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);
    if (!ownsRequest && !isAuditor) {
      throw new Error('unauthorized: access request belongs to a different identity');
    }
    return JSON.stringify(request);
  }

  /**
   * κ for one request, or null; readable by its requester and district heads. A
   * requester sees what κ says only once an auditor has decided (design §10).
   */
  async GetRecommendationCommitment(ctx, requestId) {
    const caller = getCaller(ctx);
    const request = await this._getRequest(ctx, requestId);
    const ownsRequest = request.requester.identityHash === sha256(caller.id);
    const isAuditor = caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);
    if (!ownsRequest && !isAuditor) {
      throw new Error('unauthorized: access request belongs to a different identity');
    }
    const commitment = await this._read(ctx, this._key(ctx, COMMITMENT_KEY, requestId));
    const decided = Boolean(await this._read(ctx, this._key(ctx, KEYS.AUDITOR_DECISION, requestId)));
    // The requester rule comes first, also for a requester who is a district head.
    return JSON.stringify(commitment && ownsRequest && !decided ? withheldCommitment(commitment) : commitment);
  }

  /** The committed request and its recommendation commitment κ (null before one exists). */
  /**
   * What an auditor reviews: the request, its pre-review commitment κ and, once
   * decided, the decision with its note digest h_N. The backend reads the
   * decision back after an uncertain submission to settle its staged note
   * (design §11).
   */
  async GetAuditorReview(ctx, requestId) {
    const caller = this._requireAuditor(ctx, 'GetAuditorReview');
    const request = await this._getRequest(ctx, requestId);
    // A district head who made the request is its requester, not its auditor: the
    // review carries the recommendation and the note digest (design §10).
    if (request.requester.identityHash === sha256(caller.id)) {
      throw new Error('unauthorized: a district head cannot review their own request; '
        + 'another district head decides it');
    }
    const commitment = await this._read(ctx, this._key(ctx, COMMITMENT_KEY, requestId));
    const decision = await this._read(ctx, this._key(ctx, KEYS.AUDITOR_DECISION, requestId));
    return JSON.stringify({ request, commitment, decision });
  }

  /** Every request that waits for a decision, except the caller's own. */
  async QueryPendingAuditorRequests(ctx) {
    const caller = this._requireAuditor(ctx, 'QueryPendingAuditorRequests');
    const callerHash = sha256(caller.id);
    const iterator = await ctx.stub.getStateByPartialCompositeKey(KEYS.REQUEST, []);
    const reviews = [];
    let result = await iterator.next();
    while (!result.done) {
      const request = JSON.parse(result.value.value.toString());
      if (request.status === REQUEST_STATUS.AWAITING_AUDITOR && request.requester.identityHash !== callerHash) {
        const commitment = await this._read(ctx, this._key(ctx, COMMITMENT_KEY, request.requestId));
        reviews.push({ request, commitment });
      }
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(reviews);
  }

  async GetDynamicAuthorization(ctx, authorizationId) {
    this._requireAuditor(ctx, 'GetDynamicAuthorization');
    if (!SAFE_ID.test(authorizationId || '')) throw new Error('authorizationId has invalid format');
    const authorization = await this._mustRead(
      ctx, this._key(ctx, AUTHORIZATION_KEY, authorizationId), `dynamic authorization '${authorizationId}'`
    );
    return JSON.stringify({
      authorization,
      events: await readAuthorizationEvents(ctx, authorizationId),
    });
  }

  async QueryDynamicAuthorizations(ctx, statusText = 'active') {
    this._requireAuditor(ctx, 'QueryDynamicAuthorizations');
    const status = String(statusText || 'active').toLowerCase();
    if (![...Object.values(AUTHORIZATION_STATUS), 'all'].includes(status)) {
      throw new Error('status must be one of [active, revoked, expired, superseded, all]');
    }
    const iterator = await ctx.stub.getStateByPartialCompositeKey(AUTHORIZATION_KEY, []);
    const items = [];
    let result = await iterator.next();
    while (!result.done) {
      const item = JSON.parse(result.value.value.toString());
      if (status === 'all' || item.status === status) items.push(item);
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(items);
  }

  async GetDynamicAuthorizationHistory(ctx, authorizationId) {
    this._requireAuditor(ctx, 'GetDynamicAuthorizationHistory');
    if (!SAFE_ID.test(authorizationId || '')) throw new Error('authorizationId has invalid format');
    const iterator = await ctx.stub.getHistoryForKey(this._key(ctx, AUTHORIZATION_KEY, authorizationId));
    const history = [];
    let result = await iterator.next();
    while (!result.done) {
      history.push({
        txId: result.value.txId,
        timestamp: historyTimestamp(result.value.timestamp),
        isDelete: Boolean(result.value.isDelete),
        value: result.value.isDelete || result.value.value.length === 0
          ? null : JSON.parse(result.value.value.toString()),
      });
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify({ history, events: await readAuthorizationEvents(ctx, authorizationId) });
  }

  /**
   * The decision log: for every settled request, who asked for which record, what
   * was decided — by an auditor, or automatically by a dynamic authorization —
   * and the LLM recommendation that decision was taken against, which is
   * UNAVAILABLE when the backend had none to show. A reviewer reads it in full.
   * Every other identity on the channel reads it redacted (design §10): what was
   * decided and against which recommendation stays checkable by all, without who
   * asked, for which record, or who decided. It carries no identity hash, no
   * justification, and none of the LLM's reasoning or model provenance.
   *
   * The scan reads every outcome and returns the newest `limit`, which is
   * adequate for a research prototype, not for a production log.
   */
  async QueryAccessDecisions(ctx, limitText) {
    const caller = getCaller(ctx);
    if (caller.role === null) throw new Error('unauthorized: caller identity has no role attribute');
    const limit = Number(limitText || 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('limit must be an integer from 1 to 500');
    }
    const iterator = await ctx.stub.getStateByPartialCompositeKey(KEYS.OUTCOME, []);
    const outcomes = [];
    let result = await iterator.next();
    while (!result.done) {
      outcomes.push(JSON.parse(result.value.value.toString()));
      result = await iterator.next();
    }
    await iterator.close();
    // Newest first; the request id breaks ties so the order never depends on how
    // the state database happened to return the keys.
    outcomes.sort((left, right) => String(right.recordedAtUtc).localeCompare(String(left.recordedAtUtc))
      || String(right.requestId).localeCompare(String(left.requestId)));

    const entries = [];
    for (const outcome of outcomes.slice(0, limit)) {
      const decision = await this._read(ctx, this._key(ctx, KEYS.AUDITOR_DECISION, outcome.requestId));
      entries.push({
        requestId: outcome.requestId,
        recordId: outcome.recordId,
        caseId: outcome.caseId,
        action: outcome.action,
        purpose: outcome.purpose,
        requester: {
          username: outcome.requester.username,
          organization: outcome.requester.organization,
          role: outcome.requester.role,
        },
        outcome: outcome.outcome,
        basis: outcome.basis,
        auditor: decision ? { username: decision.auditor.username, role: decision.auditor.role } : null,
        decision: decision ? decision.decision : null,
        llmRecommendation: decision ? decision.llmRecommendation : null,
        llmAgreement: decision ? decision.llmAgreement : null,
        generationStatus: decision ? decision.generationStatus ?? null : null,
        authorizationId: outcome.authorizationId,
        createdAuthorizationId: outcome.createdAuthorizationId,
        decidedAtUtc: outcome.recordedAtUtc,
        outcomeTxId: outcome.txId,
        decisionTxId: decision ? decision.txId : null,
      });
    }
    return JSON.stringify(isReviewer(caller) ? entries : entries.map(redactDecisionLogEntry));
  }

  async GetDecision(ctx, recordId, decisionId) {
    if (!SAFE_ID.test(recordId || '') || !SAFE_ID.test(decisionId || '')) {
      throw new Error('recordId and decisionId must have valid formats');
    }
    const caller = getCaller(ctx);
    const decision = await this._mustRead(
      ctx, this._key(ctx, KEYS.ACCESS_DECISION, recordId, decisionId),
      `access decision '${decisionId}' for record '${recordId}'`
    );
    const ownsDecision = decision.subject?.identityHash === sha256(caller.id);
    const isAuditor = caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);
    if (!ownsDecision && !isAuditor) {
      throw new Error('unauthorized: decision belongs to a different identity');
    }
    return JSON.stringify(decision);
  }

  async QueryDecisionsByRecord(ctx, recordId) {
    if (!SAFE_ID.test(recordId || '')) throw new Error('recordId has invalid format');
    const caller = getCaller(ctx);
    const isAuditor = caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);
    const identityHash = sha256(caller.id);
    const iterator = await ctx.stub.getStateByPartialCompositeKey(KEYS.ACCESS_DECISION, [recordId]);
    const items = [];
    let result = await iterator.next();
    while (!result.done) {
      const item = JSON.parse(result.value.value.toString());
      if (isAuditor || item.subject?.identityHash === identityHash) items.push(item);
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(items);
  }
}

module.exports = AccessContract;
module.exports.REQUEST_STATUS = REQUEST_STATUS;
module.exports.LLM_AGREEMENT = LLM_AGREEMENT;
module.exports.LLM_RECOMMENDATION = LLM_RECOMMENDATION;
module.exports.agreementFor = agreementFor;
module.exports.historyTimestamp = historyTimestamp;
