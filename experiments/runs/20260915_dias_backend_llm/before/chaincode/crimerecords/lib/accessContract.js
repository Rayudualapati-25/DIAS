'use strict';

/**
 * AccessContract — the DIAS access-request workflow (contract v1).
 *
 * 1. CreateAccessRequest (requester) commits the request and, in the same
 *    transaction, checks the exact dynamic authorization for it. A match grants
 *    access and records the LLM and the auditor as skipped; a miss waits for an
 *    LLM recommendation.
 * 2. SubmitLLMRecommendation (AIOrg llm-decider) records an advisory ALLOW or DENY
 *    with its provenance; RecordLLMRecommendationUnavailable records a generation
 *    failure without inventing a recommendation.
 * 3. SubmitAuditorDecision (AuditMSP district head) records FORCE_ALLOW or
 *    FORCE_DENY. Only LLM DENY followed by FORCE_ALLOW creates an exact-record
 *    dynamic authorization. The access outcome is recorded last.
 *
 * Every stage is an ordered lifecycle event under the request ID. This contract
 * never evaluates governance policy and never changes a recommendation.
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
const {
  FAILURE_STATUSES, GENERATION_STATUS, RESPONSE_SCHEMA_VERSION, normalizeRecommendation,
  validateRecommendationOutput,
} = require('./dias/recommendationSchema');
const {
  attestationPayload, validateProvenance, verifyAttestation,
} = require('./dias/recommendationProvenance');

const REQUEST_SCHEMA_VERSION = 'dias-access-request-v1';
const RECOMMENDATION_RECORD_SCHEMA_VERSION = 'dias-llm-recommendation-record-v1';
const AUDITOR_DECISION_SCHEMA_VERSION = 'dias-auditor-decision-v1';
const OUTCOME_SCHEMA_VERSION = 'dias-access-outcome-v1';

const REQUEST_STATUS = Object.freeze({
  AWAITING_RECOMMENDATION: 'awaiting-recommendation',
  AWAITING_AUDITOR: 'awaiting-auditor',
  GRANTED: 'granted',
  DENIED: 'denied',
});
const AUDITOR_DECISIONS = Object.freeze(['FORCE_ALLOW', 'FORCE_DENY']);
const MAX_JUSTIFICATION = 2000;
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
const FAILURE_INPUT_SCHEMA = Object.freeze({
  generationStatus: { type: 'string', required: true, enum: [...FAILURE_STATUSES] },
  errorCode: { type: 'string', required: true, pattern: /^[a-z0-9_]{1,64}$/ },
});

const shortTxId = (ctx) => ctx.stub.getTxID().slice(0, 16);

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

function bundleReference(bundle) {
  return { bundleId: bundle.bundleId, version: bundle.version, bundleHash: bundle.bundleHash };
}

function modelReference(model) {
  return {
    registrationId: model.registrationId,
    modelId: model.modelId,
    modelFamily: model.modelFamily,
    baseModel: model.baseModel,
    baseModelRevision: model.baseModelRevision,
    quantization: model.quantization,
    adapterId: model.adapterId,
    adapterHash: model.adapterHash,
    promptVersion: model.promptVersion,
    responseSchemaVersion: model.responseSchemaVersion,
    publicKeyHash: model.publicKeyHash,
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

  async _readPrivateText(ctx, key) {
    const data = await ctx.stub.getPrivateData(KEYS.PRIVATE_COLLECTION, key);
    return data && data.length > 0 ? Buffer.from(data).toString('utf8') : null;
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

  _requireAiDecider(ctx, action) {
    const caller = getCaller(ctx);
    if (caller.mspId !== KEYS.AI_DECIDER_MSP || caller.role !== KEYS.AI_DECIDER_ROLE) {
      throw new Error(
        `unauthorized: ${action} requires the ${KEYS.AI_DECIDER_ROLE} identity of ${KEYS.AI_DECIDER_MSP}`
      );
    }
    return caller;
  }

  _requireAuditor(ctx, action) {
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.AUDIT], action);
    requireRole(caller, [...DISTRICT_HEAD_ROLES], action);
    return caller;
  }

  async _activePolicyBundle(ctx) {
    return this._mustRead(ctx, KEYS.ACTIVE_POLICY_BUNDLE, 'an active governance policy bundle');
  }

  async _activeModel(ctx) {
    return this._mustRead(ctx, KEYS.ACTIVE_MODEL, 'an active recommendation model registration');
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

  _transientJustification(ctx) {
    const transient = ctx.stub.getTransient();
    const bytes = transient && transient.get
      ? (transient.get('justification') || transient.get('query')) : null;
    if (!bytes || bytes.length === 0) {
      throw new Error('the user justification must be supplied as transient data under "justification"');
    }
    const text = Buffer.from(bytes).toString('utf8');
    if (text.trim().length === 0) throw new Error('the user justification must not be empty');
    if (text.length > MAX_JUSTIFICATION) {
      throw new Error(`the user justification exceeds ${MAX_JUSTIFICATION} characters`);
    }
    return text;
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
   * Step 1 — the requester submits a request. The request is committed with its
   * verified facts and justification hash, and the exact dynamic authorization is
   * checked against committed state in the same transaction.
   */
  async CreateAccessRequest(ctx, recordId, requestJson) {
    if (!SAFE_ID.test(recordId || '')) throw new Error('recordId has invalid format');
    const caller = getCaller(ctx);
    if (caller.role === null) throw new Error('unauthorized: caller identity has no role attribute');
    const input = validateAllowList(
      parseJsonArgument(requestJson, 'access request'), REQUEST_INPUT_SCHEMA, 'access request'
    );
    const justification = this._transientJustification(ctx);
    const record = await this._mustRead(ctx, this._key(ctx, KEYS.RECORD, recordId), `record '${recordId}'`);
    const { profile, assigned, credentialStatus } = await this._requesterProfile(ctx, caller, record);
    const policyBundle = bundleReference(await this._activePolicyBundle(ctx));
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
    const justificationHash = sha256(justification);
    await ctx.stub.putPrivateData(
      KEYS.PRIVATE_COLLECTION, requestId, Buffer.from(justification, 'utf8')
    );

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
    const requesterAttributesHash = hashObject(verifiedRequest.requester);
    const resourceAttributesHash = hashObject(verifiedRequest.resource);
    const requestPayloadHash = hashObject({
      recordId,
      action: input.action,
      purpose: input.purpose,
      emergencyFlag: verifiedRequest.request.emergencyFlag,
      justificationHash,
    });
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
      requesterAttributesHash,
      resourceAttributesHash,
      requestPayloadHash,
      justificationHash,
      justificationStorage: { collection: KEYS.PRIVATE_COLLECTION, key: requestId },
      committedCertificateCredentialStatus: caller.credentialStatus,
      policyBundleAtSubmission: policyBundle,
      authorizationScope: scope,
      authorizationScopeHash: scopeHash,
      dynamicAuthorizationCheck,
      processingPath: matched ? 'dynamic-authorization' : 'llm-auditor',
      status: matched ? REQUEST_STATUS.GRANTED : REQUEST_STATUS.AWAITING_RECOMMENDATION,
      llmRecommendationStatus: matched ? 'SKIPPED' : 'PENDING',
      auditorReviewStatus: matched ? 'SKIPPED' : 'PENDING',
      recommendationId: null,
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
        caseId: record.caseId,
        recordId,
        action: input.action,
        purpose: input.purpose,
        submittedAtUtc: timestamp,
        resource: {
          recordType: record.recordType,
          sensitivityLevel: record.sensitivityLevel,
          jurisdiction: record.jurisdiction,
          owningAgency: record.owningAgency || null,
        },
        requesterAttributesHash,
        resourceAttributesHash,
        verifiedRequestHash: verifiedHash,
        requestPayloadHash,
        justificationHash,
        schemaVersion: REQUEST_SCHEMA_VERSION,
      },
    };
    const checked = {
      type: EVENT.DYNAMIC_AUTHORIZATION_CHECKED,
      data: { ...dynamicAuthorizationCheck, stateSource: 'committed world state read in this transaction' },
    };

    if (matched) {
      const skipped = {
        status: 'SKIPPED',
        reason: 'ACTIVE_DYNAMIC_AUTHORIZATION',
        authorizationId: authorization.authorizationId,
      };
      const outcome = await this._writeOutcome(ctx, {
        request, outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION',
        matchedAuthorization: authorization, timestamp,
      });
      const events = [
        submitted,
        checked,
        { type: EVENT.LLM_RECOMMENDATION_SKIPPED, data: skipped },
        {
          type: EVENT.AUDITOR_REVIEW_SKIPPED,
          data: {
            ...skipped,
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
      nextStep: 'LLM_RECOMMENDATION',
      verifiedRequestHash: verifiedHash,
    });
    return JSON.stringify(stored);
  }

  /** Everything the recommendation service needs, readable only by the AI identity. */
  async GetAccessRequestForRecommendation(ctx, requestId) {
    this._requireAiDecider(ctx, 'GetAccessRequestForRecommendation');
    const request = await this._getRequest(ctx, requestId);
    const justification = await this._readPrivateText(ctx, requestId);
    if (justification === null) {
      throw new Error('the user justification is not available to this organisation');
    }
    const policyBundle = await this._activePolicyBundle(ctx);
    const model = await this._activeModel(ctx);
    return JSON.stringify({
      requestId,
      status: request.status,
      verifiedRequest: request.verifiedRequest,
      verifiedRequestHash: request.verifiedRequestHash,
      justification,
      justificationHash: request.justificationHash,
      justificationHashVerified: sha256(justification) === request.justificationHash,
      policyBundle: bundleReference(policyBundle),
      model: modelReference(model),
    });
  }

  /** Step 2 — the AI organisation records a schema-valid advisory recommendation. */
  async SubmitLLMRecommendation(ctx, requestId, outputJson, provenanceJson, attestationSignature) {
    const caller = this._requireAiDecider(ctx, 'SubmitLLMRecommendation');
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_RECOMMENDATION);
    await this._assertFactsUnchanged(ctx, request);
    const policyBundle = await this._activePolicyBundle(ctx);
    const model = await this._activeModel(ctx);
    const output = parseJsonArgument(outputJson, 'recommendation output');
    const outputProblems = validateRecommendationOutput(output, {
      clauseRefs: policyBundle.clauseRefs,
      reasonCodes: policyBundle.reasonCodes,
      reviewFlags: policyBundle.reviewFlags,
    });
    if (outputProblems.length > 0) {
      throw new Error(`recommendation output is invalid: ${outputProblems.join('; ')}`);
    }
    const normalized = normalizeRecommendation(output);
    const provenance = parseJsonArgument(provenanceJson, 'recommendation provenance');
    const provenanceProblems = validateProvenance(provenance, {
      requestId,
      verifiedRequestHash: request.verifiedRequestHash,
      justificationHash: request.justificationHash,
      generationStatus: GENERATION_STATUS.OK,
      model,
      policyBundle,
    });
    if (provenanceProblems.length > 0) {
      throw new Error(`recommendation provenance is invalid: ${provenanceProblems.join('; ')}`);
    }
    verifyAttestation(model, attestationPayload({
      requestId,
      verifiedRequestHash: request.verifiedRequestHash,
      justificationHash: request.justificationHash,
      generationStatus: GENERATION_STATUS.OK,
      output: normalized,
      provenance,
    }), attestationSignature);
    return this._recordRecommendation(ctx, {
      caller, request, policyBundle, model, generationStatus: GENERATION_STATUS.OK,
      output: normalized, provenance, attestationSignature, errorCode: null,
    });
  }

  /** Step 2 (failure) — the AI organisation records that no recommendation was produced. */
  async RecordLLMRecommendationUnavailable(ctx, requestId, statusJson, provenanceJson, attestationSignature) {
    const caller = this._requireAiDecider(ctx, 'RecordLLMRecommendationUnavailable');
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_RECOMMENDATION);
    await this._assertFactsUnchanged(ctx, request);
    const status = validateAllowList(
      parseJsonArgument(statusJson, 'generation status'), FAILURE_INPUT_SCHEMA, 'generation status'
    );
    const policyBundle = await this._activePolicyBundle(ctx);
    const model = await this._activeModel(ctx);
    const provenance = parseJsonArgument(provenanceJson, 'recommendation provenance');
    const problems = validateProvenance(provenance, {
      requestId,
      verifiedRequestHash: request.verifiedRequestHash,
      justificationHash: request.justificationHash,
      generationStatus: status.generationStatus,
      model,
      policyBundle,
    });
    if (problems.length > 0) {
      throw new Error(`recommendation provenance is invalid: ${problems.join('; ')}`);
    }
    verifyAttestation(model, attestationPayload({
      requestId,
      verifiedRequestHash: request.verifiedRequestHash,
      justificationHash: request.justificationHash,
      generationStatus: status.generationStatus,
      output: null,
      provenance,
    }), attestationSignature);
    return this._recordRecommendation(ctx, {
      caller, request, policyBundle, model, generationStatus: status.generationStatus,
      output: null, provenance, attestationSignature, errorCode: status.errorCode,
    });
  }

  async _recordRecommendation(ctx, {
    caller, request, policyBundle, model, generationStatus, output, provenance,
    attestationSignature, errorCode,
  }) {
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const recommendationId = `LLMREC-${shortTxId(ctx)}`;
    const ok = generationStatus === GENERATION_STATUS.OK;
    const reasonKey = `${request.requestId}:llm-reason`;
    if (ok) {
      await ctx.stub.putPrivateData(KEYS.PRIVATE_COLLECTION, reasonKey, Buffer.from(output.reason, 'utf8'));
    }
    const recordedBy = actorFrom(caller, sha256(caller.id));
    const base = {
      docType: KEYS.RECOMMENDATION,
      schemaVersion: RECOMMENDATION_RECORD_SCHEMA_VERSION,
      recommendationId,
      requestId: request.requestId,
      terminology: 'LLM recommendation (advisory; not an access decision)',
      generationStatus,
      errorCode,
      recommendation: ok ? output.recommendation : null,
      reasonCode: ok ? output.reason_code : null,
      policyRefs: ok ? output.policy_refs : [],
      missingEvidence: ok ? output.missing_evidence : [],
      reviewFlags: ok ? output.review_flags : [],
      reasonHash: ok ? sha256(output.reason) : null,
      reasonStorage: ok ? { collection: KEYS.PRIVATE_COLLECTION, key: reasonKey } : null,
      responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
      verifiedRequestHash: request.verifiedRequestHash,
      policyBundle: bundleReference(policyBundle),
      model: modelReference(model),
      provenance,
      attestation: {
        signature: attestationSignature,
        publicKeyHash: model.publicKeyHash,
        modelRegistrationId: model.registrationId,
      },
      recordedBy,
      recordedAtUtc: timestamp,
      txId,
    };
    const recommendation = { ...base, recommendationHash: hashObject(base) };
    await putJson(ctx, this._key(ctx, KEYS.RECOMMENDATION, request.requestId), recommendation);
    const contextEvents = provenance.policyBundleHash ? [{
      type: EVENT.POLICY_CONTEXT_ASSEMBLED,
      data: {
        policyBundleId: provenance.policyBundleId,
        policyBundleVersion: provenance.policyBundleVersion,
        policyBundleHash: provenance.policyBundleHash,
        policyContextHash: provenance.policyContextHash || null,
        promptVersion: provenance.promptVersion,
      },
    }] : [];
    const recordedEvent = ok ? {
      type: EVENT.LLM_RECOMMENDATION_RECORDED,
      data: {
        recommendationId,
        recommendation: output.recommendation,
        reasonCode: output.reason_code,
        policyRefs: output.policy_refs,
        reviewFlags: output.review_flags,
        missingEvidence: output.missing_evidence,
        reasonHash: base.reasonHash,
        generationStatus,
        modelId: model.modelId,
        modelFamily: model.modelFamily,
        baseModelRevision: model.baseModelRevision,
        adapterId: model.adapterId,
        adapterHash: model.adapterHash,
        promptVersion: model.promptVersion,
        responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
        inferenceCompletedAtUtc: provenance.inferenceCompletedAtUtc,
        latencyMs: provenance.latencyMs,
        recommendationHash: recommendation.recommendationHash,
      },
    } : {
      type: EVENT.LLM_RECOMMENDATION_UNAVAILABLE,
      data: {
        recommendationId,
        generationStatus,
        errorCode,
        recommendation: null,
        modelId: model.modelId,
        promptVersion: model.promptVersion,
        errorDetail: provenance.errorDetail || null,
        recommendationHash: recommendation.recommendationHash,
      },
    };
    const events = [...contextEvents, recordedEvent];
    const { lastSeq } = await appendRequestEvents(ctx, {
      requestId: request.requestId, lastSeq: request.lifecycleSeq, actor: recordedBy, events,
    });
    await putJson(ctx, this._key(ctx, KEYS.REQUEST, request.requestId), {
      ...request,
      status: REQUEST_STATUS.AWAITING_AUDITOR,
      llmRecommendationStatus: generationStatus,
      recommendationId,
      lifecycleSeq: lastSeq,
    });
    emitLifecycle(ctx, {
      requestId: request.requestId,
      recordId: request.recordId,
      stages: events.map((event) => event.type),
      nextStep: 'AUDITOR_DECISION',
      generationStatus,
      recommendation: recommendation.recommendation,
    });
    return JSON.stringify(recommendation);
  }

  async _createAuthorization(ctx, {
    request, recommendation, auditorDecisionId, decision, reasonHash, actor, policyBundle,
    validUntilUtc, timestamp, txId,
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
      recommendation: {
        recommendationId: recommendation.recommendationId,
        recommendation: recommendation.recommendation,
        reasonCode: recommendation.reasonCode,
        generationStatus: recommendation.generationStatus,
      },
      auditorDecision: { auditorDecisionId, decision, reasonHash },
      policyBundle,
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
      llmRecommendationId: recommendation.recommendationId,
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

  /** Step 3 — an AuditMSP district head records the final decision. */
  async SubmitAuditorDecision(ctx, requestId, decisionText, reasonText, validUntilUtc) {
    const caller = this._requireAuditor(ctx, 'SubmitAuditorDecision');
    const decision = String(decisionText || '').toUpperCase().replace(/-/g, '_');
    if (!AUDITOR_DECISIONS.includes(decision)) {
      throw new Error('auditor decision must be one of [FORCE_ALLOW, FORCE_DENY]');
    }
    const request = await this._getRequest(ctx, requestId);
    this._requireStatus(request, REQUEST_STATUS.AWAITING_AUDITOR);
    const identityHash = sha256(caller.id);
    if (identityHash === request.requester.identityHash) {
      throw new Error('unauthorized: a requester cannot decide their own request');
    }
    const recommendation = await this._mustRead(
      ctx, this._key(ctx, KEYS.RECOMMENDATION, requestId), `LLM recommendation for request '${requestId}'`
    );
    if (recommendation.recommendationId !== request.recommendationId) {
      throw new Error('request recommendation reference does not match ledger state');
    }
    await this._assertFactsUnchanged(ctx, request);
    const reason = boundedReason(reasonText, 'auditor reason');
    const recommended = recommendation.generationStatus === GENERATION_STATUS.OK;
    const override = !recommended
      || (recommendation.recommendation === 'DENY' && decision === 'FORCE_ALLOW')
      || (recommendation.recommendation === 'ALLOW' && decision === 'FORCE_DENY');
    if (override && reason === null) {
      throw new Error('an override reason is required when the decision differs from the LLM recommendation or no recommendation exists');
    }
    const createsAuthorization = recommended
      && recommendation.recommendation === 'DENY' && decision === 'FORCE_ALLOW';
    if (!createsAuthorization && validUntilUtc) {
      throw new Error('validUntilUtc applies only when a dynamic authorization is created');
    }
    const txId = ctx.stub.getTxID();
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const auditorDecisionId = `AUDIT-${shortTxId(ctx)}`;
    const actor = actorFrom(caller, identityHash);
    const reasonHash = reason === null ? null : sha256(reason);
    const reasonKey = `${requestId}:auditor-reason`;
    if (reason !== null) {
      await ctx.stub.putPrivateData(KEYS.PRIVATE_COLLECTION, reasonKey, Buffer.from(reason, 'utf8'));
    }
    const policyBundle = bundleReference(await this._activePolicyBundle(ctx));
    const authorization = createsAuthorization
      ? await this._createAuthorization(ctx, {
        request, recommendation, auditorDecisionId, decision, reasonHash, actor, policyBundle,
        validUntilUtc, timestamp, txId,
      })
      : null;
    const createdAuthorizationId = authorization ? authorization.authorization.authorizationId : null;
    const reviewedRecommendation = {
      recommendationId: recommendation.recommendationId,
      generationStatus: recommendation.generationStatus,
      recommendation: recommendation.recommendation,
      reasonCode: recommendation.reasonCode,
      recommendationHash: recommendation.recommendationHash,
    };
    const auditorBase = {
      docType: KEYS.AUDITOR_DECISION,
      schemaVersion: AUDITOR_DECISION_SCHEMA_VERSION,
      auditorDecisionId,
      requestId,
      auditor: { ...actor, stableUserId: stableUserId(caller.mspId, caller.enrollmentId) },
      reviewedRecommendation,
      decision,
      override,
      reasonHash,
      reasonStorage: reason === null ? null : { collection: KEYS.PRIVATE_COLLECTION, key: reasonKey },
      verifiedRequestHash: request.verifiedRequestHash,
      requestStatusAtDecision: request.status,
      policyBundle,
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
          reviewedRecommendation,
          decision,
          override,
          overrideReasonHash: reasonHash,
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
    const isAiDecider = caller.mspId === KEYS.AI_DECIDER_MSP && caller.role === KEYS.AI_DECIDER_ROLE;
    const isAuditor = caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);
    if (!ownsRequest && !isAiDecider && !isAuditor) {
      throw new Error('unauthorized: access request belongs to a different identity');
    }
    return JSON.stringify(request);
  }

  async _auditorReview(ctx, request) {
    const recommendation = request.recommendationId
      ? await this._read(ctx, this._key(ctx, KEYS.RECOMMENDATION, request.requestId)) : null;
    const justification = await this._readPrivateText(ctx, request.requestId);
    const llmReason = recommendation && recommendation.reasonStorage
      ? await this._readPrivateText(ctx, recommendation.reasonStorage.key) : null;
    return {
      request,
      recommendation,
      justification,
      justificationHashVerified: justification !== null
        && sha256(justification) === request.justificationHash,
      llmReason,
      llmReasonHashVerified: llmReason !== null && sha256(llmReason) === recommendation.reasonHash,
    };
  }

  async GetAuditorReview(ctx, requestId) {
    this._requireAuditor(ctx, 'GetAuditorReview');
    const request = await this._getRequest(ctx, requestId);
    return JSON.stringify(await this._auditorReview(ctx, request));
  }

  async QueryPendingAuditorRequests(ctx) {
    this._requireAuditor(ctx, 'QueryPendingAuditorRequests');
    const iterator = await ctx.stub.getStateByPartialCompositeKey(KEYS.REQUEST, []);
    const reviews = [];
    let result = await iterator.next();
    while (!result.done) {
      const request = JSON.parse(result.value.value.toString());
      if (request.status === REQUEST_STATUS.AWAITING_AUDITOR) {
        reviews.push(await this._auditorReview(ctx, request));
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
module.exports.historyTimestamp = historyTimestamp;
