'use strict';

/**
 * Test world for the DIAS contracts.
 *
 * One committed ledger that every signed transaction reads from and writes back
 * to. A transaction that throws writes nothing, as on Fabric. The repository
 * governance policy bundle and a fixture recommendation signer are registered
 * through PolicyContract, exactly as a deployment does.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AccessContract = require('../lib/accessContract');
const AuditContract = require('../lib/auditContract');
const PolicyContract = require('../lib/policyContract');
const RecordContract = require('../lib/recordContract');
const { canonicalize } = require('../lib/util/validate');
const { attestationPayload } = require('../lib/dias/recommendationProvenance');
const {
  CALLERS, RECORD_META, buildMockContext, cloneInto, seedCase,
} = require('./testHelpers');

const BUNDLE_PATH = path.resolve(__dirname, '..', '..', '..', 'policies', 'dias-governance-policy-v1.json');
const BUNDLE_JSON = fs.readFileSync(BUNDLE_PATH, 'utf8');

const AI_CALLER = Object.freeze({
  identityId: 'llm-decider',
  mspId: 'AIOrgMSP',
  attrs: { role: 'llm-decider', credentialStatus: 'active' },
});

const FIXTURE_MODEL = Object.freeze({
  modelId: 'fixture-recommender-v1',
  modelFamily: 'fixture',
  baseModel: 'none/fixture',
  baseModelRevision: 'fixture-r1',
  quantization: 'none',
  promptVersion: 'dias-recommendation-prompt-v1',
  responseSchemaVersion: 'dias-recommendation-response-v1',
  registrationPurpose: 'fixture-test',
});

const OUTPUTS = Object.freeze({
  allow: Object.freeze({
    recommendation: 'ALLOW',
    reason_code: 'POLICY_SATISFIED',
    reason: 'Role inspector may view fir records and no DENY clause applies (GP-RBAC:C2@v1, GP-DEFAULT:C1@v1).',
    policy_refs: ['GP-RBAC:C2@v1', 'GP-DEFAULT:C1@v1'],
    missing_evidence: [],
    review_flags: [],
  }),
  deny: Object.freeze({
    recommendation: 'DENY',
    reason_code: 'NOT_ASSIGNED',
    reason: 'Role inspector is not assignment-exempt and the requester is not assigned to case CASE-1 (GP-ASSIGN:C1@v1).',
    policy_refs: ['GP-ASSIGN:C1@v1'],
    missing_evidence: [],
    review_flags: [],
  }),
});

function profileFor(caller, org, overrides = {}) {
  return {
    docType: 'user',
    userId: caller.identityId,
    fabricUser: caller.identityId,
    org,
    role: caller.attrs.role,
    rank: caller.attrs.rank,
    station: caller.attrs.station,
    jurisdiction: caller.attrs.jurisdiction,
    clearance: caller.attrs.clearance,
    credentialStatus: 'active',
    ...overrides,
  };
}

const DEFAULT_PROFILES = Object.freeze([
  profileFor(CALLERS.inspector, 'police'),
  profileFor(CALLERS.constable, 'police'),
  profileFor(CALLERS.analyst, 'forensics'),
  profileFor(CALLERS.auditor, 'audit'),
]);

function createDiasWorld() {
  const ledger = buildMockContext({ mspId: 'PoliceMSP' });
  const contracts = {
    access: new AccessContract(),
    audit: new AuditContract(),
    policy: new PolicyContract(),
    records: new RecordContract(),
  };
  const signer = crypto.generateKeyPairSync('ed25519');
  const counter = { value: 0 };

  const nextTx = (prefix) => {
    counter.value += 1;
    return `${prefix}${String(counter.value).padStart(4, '0')}${'f'.repeat(48)}`;
  };

  /** Run one signed transaction against the committed ledger. */
  async function run(caller, txId, fn, { transient, timestamp } = {}) {
    const ctx = buildMockContext({ ...caller, txId });
    cloneInto(ledger, ctx);
    if (transient) {
      ctx._setTransient(new Map(Object.entries(transient)
        .map(([key, value]) => [key, Buffer.from(value, 'utf8')])));
    }
    if (timestamp) ctx.stub.getDateTimestamp = () => new Date(timestamp);
    const raw = await fn(ctx);
    cloneInto(ctx, ledger);
    return { ctx, result: typeof raw === 'string' ? JSON.parse(raw) : raw };
  }

  function readState(type, ...parts) {
    const value = ledger._state.get(ledger.stub.createCompositeKey(type, parts));
    return value ? JSON.parse(value) : null;
  }

  function readPlain(key) {
    const value = ledger._state.get(key);
    return value ? JSON.parse(value) : null;
  }

  async function putState(type, parts, value) {
    await ledger.stub.putState(
      ledger.stub.createCompositeKey(type, parts), Buffer.from(JSON.stringify(value))
    );
  }

  function eventsOf(keyType, ownerId) {
    const prefix = ledger.stub.createCompositeKey(keyType, [ownerId]);
    return [...ledger._state.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => JSON.parse(value))
      .sort((left, right) => left.seq - right.seq);
  }

  const sign = (payload) => crypto.sign(
    null, Buffer.from(canonicalize(payload), 'utf8'), signer.privateKey
  ).toString('base64');

  function provenanceFor(request, overrides = {}) {
    const bundle = readPlain('activeGovernancePolicyBundle');
    return {
      schemaVersion: 'dias-recommendation-provenance-v1',
      requestId: request.requestId,
      modelId: FIXTURE_MODEL.modelId,
      modelFamily: FIXTURE_MODEL.modelFamily,
      baseModel: FIXTURE_MODEL.baseModel,
      baseModelRevision: FIXTURE_MODEL.baseModelRevision,
      quantization: FIXTURE_MODEL.quantization,
      adapterId: null,
      adapterHash: null,
      servedModel: 'fixture',
      promptVersion: FIXTURE_MODEL.promptVersion,
      responseSchemaVersion: FIXTURE_MODEL.responseSchemaVersion,
      verifiedRequestHash: request.verifiedRequestHash,
      justificationHash: request.justificationHash,
      decoding: { temperature: 0, topP: 1, maxTokens: 256 },
      inferenceStartedAtUtc: '2026-08-05T12:00:01.000Z',
      inferenceCompletedAtUtc: '2026-08-05T12:00:03.000Z',
      generationStatus: 'OK',
      policyBundleId: bundle.bundleId,
      policyBundleVersion: bundle.version,
      policyBundleHash: bundle.bundleHash,
      policyContextHash: 'd'.repeat(64),
      promptHash: 'e'.repeat(64),
      rawOutputHash: 'f'.repeat(64),
      latencyMs: { contextAssembly: 1, inference: 2000, validation: 1, total: 2002 },
      ...overrides,
    };
  }

  const world = {
    ledger,
    contracts,
    signer,
    AI_CALLER,
    readState,
    readPlain,
    putState,
    run,
    nextTx,
    sign,
    provenanceFor,

    async seed({ assignedUsers = [], profiles = DEFAULT_PROFILES, model = true, bundle = true } = {}) {
      await run(CALLERS.inspector, 'SEED-RECORDS', async (ctx) => {
        await seedCase(ctx, 'CASE-1', { assignedUsers });
        for (const profile of profiles) {
          await ctx.stub.putState(
            ctx.stub.createCompositeKey('user', [profile.fabricUser]), Buffer.from(JSON.stringify(profile))
          );
        }
        await contracts.records.CreateCaseRecord(ctx, 'FIR-1', JSON.stringify(RECORD_META));
        await contracts.records.CreateCaseRecord(ctx, 'FIR-2', JSON.stringify({
          ...RECORD_META, offChainReference: 'vault://police/FIR-2',
        }));
      });
      if (bundle) {
        await run(CALLERS.auditor, 'SEED-BUNDLE', (ctx) => contracts.policy.RegisterGovernancePolicyBundle(ctx, BUNDLE_JSON));
        await run(CALLERS.auditor, 'SEED-BUNDLE-ACTIVATE', (ctx) => contracts.policy
          .ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v1'));
      }
      if (model) {
        const publicKeyPem = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const { result: registration } = await run(CALLERS.auditor, 'SEEDMODEL0000001', (ctx) => contracts.policy
          .RegisterRecommendationModel(ctx, JSON.stringify(FIXTURE_MODEL), publicKeyPem));
        await run(CALLERS.auditor, 'SEED-MODEL-ACTIVATE', (ctx) => contracts.policy
          .ActivateRecommendationModel(ctx, registration.registrationId));
      }
      return world;
    },

    readRequest: (requestId) => readState('diasAccessRequest', requestId),
    requestEvents: (requestId) => eventsOf('diasRequestEvent', requestId),
    eventTypes: (requestId) => eventsOf('diasRequestEvent', requestId).map((event) => event.eventType),
    authorizationEvents: (authorizationId) => eventsOf('diasAuthorizationEvent', authorizationId),

    submit(caller, {
      recordId = 'FIR-1', action = 'view', purpose = 'investigation', emergencyFlag,
      justification = 'Reviewing the FIR for the open investigation.', timestamp,
    } = {}) {
      const input = { action, purpose, ...(emergencyFlag === undefined ? {} : { emergencyFlag }) };
      return run(caller, nextTx('SUBMIT'), (ctx) => contracts.access.CreateAccessRequest(
        ctx, recordId, JSON.stringify(input)
      ), { transient: justification === null ? undefined : { justification }, timestamp });
    },

    recommend(requestId, output, { provenance = {}, signature, caller = AI_CALLER, timestamp } = {}) {
      const request = readState('diasAccessRequest', requestId);
      const fullProvenance = provenanceFor(request, provenance);
      const payload = attestationPayload({
        requestId,
        verifiedRequestHash: request.verifiedRequestHash,
        justificationHash: request.justificationHash,
        generationStatus: 'OK',
        output,
        provenance: fullProvenance,
      });
      return run(caller, nextTx('LLMREC'), (ctx) => contracts.access.SubmitLLMRecommendation(
        ctx, requestId, JSON.stringify(output), JSON.stringify(fullProvenance), signature || sign(payload)
      ), { timestamp });
    },

    unavailable(requestId, generationStatus = 'UNAVAILABLE', errorCode = 'server_unreachable', { caller = AI_CALLER } = {}) {
      const request = readState('diasAccessRequest', requestId);
      const provenance = provenanceFor(request, {
        generationStatus,
        policyContextHash: undefined,
        promptHash: undefined,
        rawOutputHash: undefined,
        errorDetail: 'fetch failed',
      });
      const clean = JSON.parse(JSON.stringify(provenance));
      const payload = attestationPayload({
        requestId,
        verifiedRequestHash: request.verifiedRequestHash,
        justificationHash: request.justificationHash,
        generationStatus,
        output: null,
        provenance: clean,
      });
      return run(caller, nextTx('LLMFAIL'), (ctx) => contracts.access.RecordLLMRecommendationUnavailable(
        ctx, requestId, JSON.stringify({ generationStatus, errorCode }), JSON.stringify(clean), sign(payload)
      ));
    },

    decide(requestId, decision, reason = '', { validUntilUtc = '', caller = CALLERS.auditor, timestamp } = {}) {
      return run(caller, nextTx('AUDIT'), (ctx) => contracts.access.SubmitAuditorDecision(
        ctx, requestId, decision, reason, validUntilUtc
      ), { timestamp });
    },

    revoke(authorizationId, reason, { caller = CALLERS.auditor } = {}) {
      return run(caller, nextTx('REVOKE'), (ctx) => contracts.access.RevokeDynamicAuthorization(
        ctx, authorizationId, reason
      ));
    },

    /** Request -> LLM DENY -> auditor FORCE_ALLOW: the authorization-creating path. */
    async createAuthorization(caller = CALLERS.inspector, options = {}) {
      const { result: request } = await world.submit(caller, options);
      await world.recommend(request.requestId, OUTPUTS.deny);
      const { result } = await world.decide(
        request.requestId, 'FORCE_ALLOW', 'Verified supervisor tasking for this record.',
        { validUntilUtc: options.validUntilUtc || '' }
      );
      return { request, decision: result, authorization: result.dynamicAuthorization };
    },
  };
  return world;
}

module.exports = {
  AI_CALLER, BUNDLE_JSON, DEFAULT_PROFILES, FIXTURE_MODEL, OUTPUTS, createDiasWorld, profileFor,
};
