'use strict';

/**
 * AccessContract — the DIAS access-request workflow (contract v2).
 *
 * 1. CreateAccessRequest (requester) commits who asked for which record, with the
 *    action and purpose, and in the same transaction checks the exact dynamic
 *    authorization for it. A match grants access without auditor review; a miss
 *    waits for the auditor.
 * 2. SubmitAuditorDecision (AuditMSP district head) commits FORCE_ALLOW or
 *    FORCE_DENY and whether that decision agreed with the LLM recommendation shown
 *    to the auditor. The LLM runs in the application backend, and its
 *    recommendation is never written to the ledger. A FORCE_ALLOW that did not
 *    agree with the LLM (an LLM DENY) creates an exact-record dynamic
 *    authorization. The access outcome is recorded last.
 *
 * Every stage is an ordered lifecycle event under the request ID. This contract
 * never evaluates governance policy.
 */

const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const {
  SAFE_ID, hashObject, sha256, validateAllowList,
} = require('./util/validate');
const { putJson } = require('./util/state');
const { ACTIONS, PURPOSES, DISTRICT_HEAD_ROLES } = require('./policy/policyV1');
const KEYS = require('./dias/keys');
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

const REQUEST_SCHEMA_VERSION = 'dias-access-request-v2';
const AUDITOR_DECISION_SCHEMA_VERSION = 'dias-auditor-decision-v2';
const OUTCOME_SCHEMA_VERSION = 'dias-access-outcome-v1';

const REQUEST_STATUS = Object.freeze({
  AWAITING_AUDITOR: 'awaiting-auditor',
  GRANTED: 'granted',
  DENIED: 'denied',
});
const AUDITOR_DECISIONS = Object.freeze(['FORCE_ALLOW', 'FORCE_DENY']);
const LLM_AGREEMENT = Object.freeze({
  AGREED: 'AGREED',
  NOT_AGREED: 'NOT_AGREED',
  NO_RECOMMENDATION: 'NO_RECOMMENDATION',
});
const MAX_REASON = 500;
const ORG_TO_MSP = Object.freeze({
  police: MSP.POLICE,
  forensics: MSP.FORENSICS,
  prosecution: MSP.PROSECUTION,
  court: MSP.COURT,
  audit: MSP.AUDIT,
});

const REQUEST_INPUT_SCHEMA = Object.freeze({
  action: { type: 'string', required: true, enum: [...ACTIONS] },
  purpose: { type: 'string', required: true, enum: [...PURPOSES] },
  emergencyFlag: { type: 'boolean', required: false, default: false },
});

const shortTxId = (ctx) => ctx.stub.getTxID().slice(0, 16);
const token = (value) => String(value || '').trim().toUpperCase().replace(/[-\s]+/g, '_');

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
      requestContext: request.verifiedRequest.request,
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

  async _checkAuthorization(ctx, scopeHash, conditionsHash, timestamp) {
    const index = await this._read(ctx, this._key(ctx, AUTHORIZATION_SCOPE_KEY, scopeHash));
    const authorization = index
      ? await this._read(ctx, this._key(ctx, AUTHORIZATION_KEY, index.authorizationId)) : null;
    return {
      authorization,
      match: matchAuthorization(authorization, { scopeHash, conditionsHash, timestamp }),
    };
  }

  async _writeOutcome(ctx, {
    request, outcome, basis, auditorDecisionId = null, matchedAuthorization = null,
    createdAuthorizationId = null, timestamp,
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
      auditorDecisionId,
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
      status: granted ? 'granted' : 'denied',
      decisionAuthority: basis === 'DYNAMIC_AUTHORIZATION' ? 'dynamic-authorization' : 'auditor',
      authorizationId: record.authorizationId,
      auditorDecisionId,
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
    const { profile, assigned, credentialStatus } = await this._requesterProfile(ctx, caller, record);
    const verifiedRequest = buildVerifiedRequest({
      subject: subjectFromProfile(caller.mspId, profile, credentialStatus),
      record,
      requestContext: {
        action: input.action,
        purpose: input.purpose,
        emergencyFlag: input.emergencyFlag === true,
        approvalTokenPresent: false,
      },
      assignedToRequestedCase: assigned,
    });
    const verifiedHash = verifiedRequestHash(verifiedRequest);
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const requestId = `REQ-${shortTxId(ctx)}`;
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
      ctx, scopeHash, verifiedHash, timestamp
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
      verifiedRequestSchemaVersion: VERIFIED_REQUEST_SCHEMA_VERSION,
      verifiedRequest,
      verifiedRequestHash: verifiedHash,
      committedCertificateCredentialStatus: caller.credentialStatus,
      authorizationScope: scope,
      authorizationScopeHash: scopeHash,
      dynamicAuthorizationCheck,
      processingPath: matched ? 'dynamic-authorization' : 'auditor-review',
      status: matched ? REQUEST_STATUS.GRANTED : REQUEST_STATUS.AWAITING_AUDITOR,
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
    request, auditorDecisionId, decision, llmAgreement, actor, validUntilUtc, timestamp, txId,
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
      auditorDecision: { auditorDecisionId, decision, llmAgreement },
      validUntilUtc,
      previous,
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
      validUntilUtc: created.validUntilUtc,
      originatingRequestId: request.requestId,
      auditorDecisionId,
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
   * Step 2 — an AuditMSP district head commits the final decision and whether it
   * agreed with the LLM recommendation the auditor was shown. NO_RECOMMENDATION
   * means the backend had no valid recommendation to show.
   */
  async SubmitAuditorDecision(ctx, requestId, decisionText, llmAgreementText, validUntilUtc) {
    const caller = this._requireAuditor(ctx, 'SubmitAuditorDecision');
    const decision = token(decisionText);
    if (!AUDITOR_DECISIONS.includes(decision)) {
      throw new Error('auditor decision must be one of [FORCE_ALLOW, FORCE_DENY]');
    }
    const llmAgreement = token(llmAgreementText);
    if (!Object.values(LLM_AGREEMENT).includes(llmAgreement)) {
      throw new Error('llmAgreement must be one of [AGREED, NOT_AGREED, NO_RECOMMENDATION]');
    }
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    const identityHash = sha256(caller.id);
    if (identityHash === request.requester.identityHash) {
      throw new Error('unauthorized: a requester cannot decide their own request');
    }
    await this._assertFactsUnchanged(ctx, request);
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
        request, auditorDecisionId, decision, llmAgreement, actor, validUntilUtc, timestamp, txId,
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
      llmAgreement,
      verifiedRequestHash: request.verifiedRequestHash,
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
          llmAgreement,
          verifiedRequestHash: request.verifiedRequestHash,
          auditorDecisionHash: auditorDecision.auditorDecisionHash,
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
      llmAgreement,
      createdAuthorizationId,
    });
    return JSON.stringify({
      auditorDecision,
      accessOutcome: outcome.record,
      dynamicAuthorization: authorization ? authorization.authorization : null,
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

  async GetAuditorReview(ctx, requestId) {
    this._requireAuditor(ctx, 'GetAuditorReview');
    const request = await this._getRequest(ctx, requestId);
    return JSON.stringify({ request });
  }

  async QueryPendingAuditorRequests(ctx) {
    this._requireAuditor(ctx, 'QueryPendingAuditorRequests');
    const iterator = await ctx.stub.getStateByPartialCompositeKey(KEYS.REQUEST, []);
    const reviews = [];
    let result = await iterator.next();
    while (!result.done) {
      const request = JSON.parse(result.value.value.toString());
      if (request.status === REQUEST_STATUS.AWAITING_AUDITOR) reviews.push({ request });
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
   * The public decision log: for every settled request, who asked for which
   * record and what was decided — by an auditor, with its LLM agreement, or
   * automatically by a dynamic authorization. Readable by every identity on the
   * channel, because "who decided what, and for whom" is exactly what the shared
   * ledger exists to make checkable. It carries no identity hash, no
   * justification, and nothing the LLM produced.
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
        llmAgreement: decision ? decision.llmAgreement : null,
        authorizationId: outcome.authorizationId,
        createdAuthorizationId: outcome.createdAuthorizationId,
        decidedAtUtc: outcome.recordedAtUtc,
        outcomeTxId: outcome.txId,
        decisionTxId: decision ? decision.txId : null,
      });
    }
    return JSON.stringify(entries);
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
module.exports.historyTimestamp = historyTimestamp;
