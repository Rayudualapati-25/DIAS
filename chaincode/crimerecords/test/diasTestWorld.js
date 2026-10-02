'use strict';

/**
 * Test world for the DIAS contracts.
 *
 * One committed ledger that every signed transaction reads from and writes back
 * to. A transaction that throws writes nothing, as on Fabric. The LLM runs in the
 * application backend, so this world submits requests and auditor decisions
 * carrying the recommendation value the auditor was shown — ALLOW, DENY, or
 * UNAVAILABLE. Nothing else about the LLM reaches the ledger.
 */

const AccessContract = require('../lib/accessContract');
const AuditContract = require('../lib/auditContract');
const GovernanceContract = require('../lib/governanceContract');
const RecordContract = require('../lib/recordContract');
const {
  CALLERS, RECORD_META, buildMockContext, cloneInto, seedCase,
} = require('./testHelpers');
const crypto = require('crypto');
const { hashCanonical, hashText } = require('../lib/dias/commitments');
const {
  provenanceMessage, provenancePayload,
} = require('../lib/dias/recommendationCommitment');

/** The recommendation service's signing key in these tests (Ed25519, as in design §6.1). */
function createSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    sign: (payload) => crypto.sign(null, provenanceMessage(payload), privateKey).toString('base64'),
  };
}

/** A recommendation object M for a request, and its digest h_M. */
function recommendationObjectFor(requestId, recommendation, generationStatus) {
  return {
    schemaVersion: 'dias-recommendation-object-v1',
    requestId,
    generationStatus,
    recommendation,
    output: recommendation ? { recommendation, reason_code: 'TEST', reason: 'test', policy_refs: [], missing_evidence: [], review_flags: [] } : null,
  };
}

const NOTE_REQUIRED = Object.freeze(['NOT_AGREED', 'NO_RECOMMENDATION']);

/** The justification every test request carries unless a test supplies its own. */
const DEFAULT_JUSTIFICATION = 'Reviewing the FIR for the open investigation.';

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
  profileFor(CALLERS.auditor2, 'audit'),
]);

/** The policy every seeded world activates (its digest is the v3 policy digest of policies/). */
const POLICY_V1 = Object.freeze({
  policyVersion: 'dias-governance-policy-v1',
  policyHash: '9c66ce9ec8954dd0a976db933336aa05dd45acd683abf56f8a65472a4d298c81',
  bundleId: 'dias-governance-policy',
});

function createDiasWorld() {
  const ledger = buildMockContext({ mspId: 'PoliceMSP' });
  const signer = createSigner();
  const contracts = {
    access: new AccessContract(),
    audit: new AuditContract(),
    governance: new GovernanceContract(),
    records: new RecordContract(),
  };
  const counter = { value: 0 };

  const nextTx = (prefix) => {
    counter.value += 1;
    return `${prefix}${String(counter.value).padStart(4, '0')}${'f'.repeat(48)}`;
  };

  /** Run one signed transaction against the committed ledger. */
  async function run(caller, txId, fn, { timestamp } = {}) {
    const ctx = buildMockContext({ ...caller, txId });
    cloneInto(ledger, ctx);
    if (timestamp) ctx.stub.getDateTimestamp = () => new Date(timestamp);
    const raw = await fn(ctx);
    cloneInto(ctx, ledger);
    return { ctx, result: typeof raw === 'string' ? JSON.parse(raw) : raw };
  }

  function readState(type, ...parts) {
    const value = ledger._state.get(ledger.stub.createCompositeKey(type, parts));
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

  const world = {
    ledger,
    signer,
    contracts,
    readState,
    putState,
    run,
    nextTx,

    async seed({
      assignedUsers = [], profiles = DEFAULT_PROFILES, policy = POLICY_V1, registerSigner = true,
    } = {}) {
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
      if (policy) {
        await world.registerPolicy(policy);
        await world.activatePolicy(policy.policyVersion);
      }
      if (registerSigner) await world.registerSigner(signer.publicKeyPem);
      return world;
    },

    async registerSigner(publicKeyPem, { caller = CALLERS.auditor, label = 'recommendation-service' } = {}) {
      const registered = await run(caller, nextTx('SIGNER'), (ctx) => contracts.governance
        .RegisterRecommendationSigner(ctx, publicKeyPem, label));
      if (publicKeyPem === signer.publicKeyPem) world.signerKeyId = registered.result.keyId;
      return registered;
    },

    /**
     * The commitment κ the recommendation service would produce for a request:
     * bound to the request's committed hashes and policy, signed by `sign`.
     */
    commitmentFor(requestId, {
      recommendation = 'ALLOW', generationStatus = 'OK', modelVersion = 'mlx-community/Qwen3-14B-4bit@a4d9b2df',
      sign = signer.sign, signerKeyId, overrides = {}, signedOverrides = {},
    } = {}) {
      const request = world.readRequest(requestId);
      const value = recommendation === null || generationStatus !== 'OK' ? null : recommendation;
      const object = recommendationObjectFor(requestId, value, generationStatus);
      const fields = {
        contextHash: request.verifiedRequestHash,
        claimsHash: request.requesterClaimsHash,
        justificationHash: request.justificationHash,
        policyVersion: request.policyVersion,
        policyHash: request.policyHash,
        recommendation: value,
        generationStatus,
        modelVersion,
        recommendationHash: hashCanonical('recommendation', object),
        signerKeyId: signerKeyId || world.signerKeyId,
        ...signedOverrides,
      };
      const signature = sign(provenancePayload({ channel: 'diaschannel', requestId, ...fields }));
      return { ...fields, signature, ...overrides };
    },

    commit(requestId, input, { caller = CALLERS.constable, timestamp } = {}) {
      return run(caller, nextTx('KAPPA'), (ctx) => contracts.access.CommitRecommendation(
        ctx, requestId, JSON.stringify(input)
      ), { timestamp });
    },

    registerPolicy({ policyVersion, policyHash, bundleId = 'dias-governance-policy' }, { caller = CALLERS.auditor } = {}) {
      return run(caller, nextTx('POLREG'), (ctx) => contracts.governance.RegisterPolicyVersion(
        ctx, policyVersion, policyHash, bundleId
      ));
    },

    activatePolicy(policyVersion, { caller = CALLERS.auditor2 } = {}) {
      return run(caller, nextTx('POLACT'), (ctx) => contracts.governance.ActivatePolicyVersion(ctx, policyVersion));
    },

    /** Register and activate a new policy version, retiring the current one. */
    async changePolicy(policyVersion = 'dias-governance-policy-v2', policyHash = 'e'.repeat(64)) {
      await world.registerPolicy({ policyVersion, policyHash });
      return world.activatePolicy(policyVersion);
    },

    readRequest: (requestId) => readState('diasAccessRequest', requestId),
    requestEvents: (requestId) => eventsOf('diasRequestEvent', requestId),
    eventTypes: (requestId) => eventsOf('diasRequestEvent', requestId).map((event) => event.eventType),
    authorizationEvents: (authorizationId) => eventsOf('diasAuthorizationEvent', authorizationId),

    submit(caller, {
      recordId = 'FIR-1', action = 'view', purpose = 'investigation', emergencyDeclared, timestamp,
      justification = DEFAULT_JUSTIFICATION,
    } = {}) {
      const input = {
        action,
        purpose,
        justificationHash: hashText('justification', justification),
        ...(emergencyDeclared === undefined ? {} : { emergencyDeclared }),
      };
      return run(caller, nextTx('SUBMIT'), (ctx) => contracts.access.CreateAccessRequest(
        ctx, recordId, JSON.stringify(input)
      ), { timestamp });
    },

    /**
     * Commit the recommendation (unless one is committed already, or `recommendation`
     * is null for "none at all"), then submit the auditor decision. A note hash is
     * supplied whenever the agreement requires one, unless the test passes its own.
     * 'UNAVAILABLE' commits a failed generation with that status.
     */
    async decide(requestId, decision, recommendation = 'ALLOW', {
      validUntilUtc = '', caller = CALLERS.auditor, timestamp, noteHash, generationStatus,
    } = {}) {
      const failed = recommendation === 'UNAVAILABLE' || (generationStatus && generationStatus !== 'OK');
      const status = generationStatus || (failed ? 'UNAVAILABLE' : 'OK');
      if (recommendation !== null && !world.readState('diasRecommendationCommitment', requestId)) {
        await world.commit(requestId, world.commitmentFor(requestId, {
          recommendation: failed ? null : recommendation, generationStatus: status,
        }), { timestamp });
      }
      const committed = world.readState('diasRecommendationCommitment', requestId);
      const usable = committed && committed.generationStatus === 'OK';
      const agrees = usable && (committed.recommendation === 'ALLOW') === (String(decision).toUpperCase().replace('-', '_') === 'FORCE_ALLOW');
      const agreement = !usable ? 'NO_RECOMMENDATION' : (agrees ? 'AGREED' : 'NOT_AGREED');
      const note = noteHash !== undefined ? noteHash
        : (NOTE_REQUIRED.includes(agreement) ? hashText('note', `Auditor note for ${requestId}`) : '');
      return run(caller, nextTx('AUDIT'), (ctx) => contracts.access.SubmitAuditorDecision(
        ctx, requestId, decision, note, validUntilUtc
      ), { timestamp });
    },

    expire(requestId, { caller = CALLERS.constable, timestamp } = {}) {
      return run(caller, nextTx('EXPIRE'), (ctx) => contracts.access.ExpirePendingRequest(ctx, requestId), { timestamp });
    },

    cancel(requestId, { caller = CALLERS.inspector, timestamp } = {}) {
      return run(caller, nextTx('CANCEL'), (ctx) => contracts.access.CancelAccessRequest(ctx, requestId), { timestamp });
    },

    setParameters(parameters, { caller = CALLERS.auditor, timestamp } = {}) {
      return run(caller, nextTx('PARAMS'), (ctx) => contracts.governance.SetDiasParameters(
        ctx, JSON.stringify(parameters)
      ), { timestamp });
    },

    revoke(authorizationId, reason, { caller = CALLERS.auditor } = {}) {
      return run(caller, nextTx('REVOKE'), (ctx) => contracts.access.RevokeDynamicAuthorization(
        ctx, authorizationId, reason
      ));
    },

    /** Request, then an auditor FORCE_ALLOW that did not agree with an LLM DENY. */
    async createAuthorization(caller = CALLERS.inspector, options = {}) {
      const { result: request } = await world.submit(caller, options);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY', { validUntilUtc: options.validUntilUtc || '' }
      );
      return { request, decision: result, authorization: result.dynamicAuthorization };
    },
  };
  return world;
}

module.exports = {
  DEFAULT_JUSTIFICATION, DEFAULT_PROFILES, POLICY_V1, createDiasWorld, createSigner, profileFor,
  recommendationObjectFor,
};
