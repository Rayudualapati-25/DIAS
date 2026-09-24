'use strict';

/**
 * Test world for the DIAS contracts.
 *
 * One committed ledger that every signed transaction reads from and writes back
 * to. A transaction that throws writes nothing, as on Fabric. The LLM runs in the
 * application backend, so this world only submits requests and auditor decisions
 * with their LLM agreement; nothing about the LLM reaches the ledger.
 */

const AccessContract = require('../lib/accessContract');
const AuditContract = require('../lib/auditContract');
const RecordContract = require('../lib/recordContract');
const {
  CALLERS, RECORD_META, buildMockContext, cloneInto, seedCase,
} = require('./testHelpers');

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
    contracts,
    readState,
    putState,
    run,
    nextTx,

    async seed({ assignedUsers = [], profiles = DEFAULT_PROFILES } = {}) {
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
      return world;
    },

    readRequest: (requestId) => readState('diasAccessRequest', requestId),
    requestEvents: (requestId) => eventsOf('diasRequestEvent', requestId),
    eventTypes: (requestId) => eventsOf('diasRequestEvent', requestId).map((event) => event.eventType),
    authorizationEvents: (authorizationId) => eventsOf('diasAuthorizationEvent', authorizationId),

    submit(caller, {
      recordId = 'FIR-1', action = 'view', purpose = 'investigation', emergencyFlag, timestamp,
    } = {}) {
      const input = { action, purpose, ...(emergencyFlag === undefined ? {} : { emergencyFlag }) };
      return run(caller, nextTx('SUBMIT'), (ctx) => contracts.access.CreateAccessRequest(
        ctx, recordId, JSON.stringify(input)
      ), { timestamp });
    },

    decide(requestId, decision, llmAgreement = 'AGREED', {
      validUntilUtc = '', caller = CALLERS.auditor, timestamp,
    } = {}) {
      return run(caller, nextTx('AUDIT'), (ctx) => contracts.access.SubmitAuditorDecision(
        ctx, requestId, decision, llmAgreement, validUntilUtc
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
      const { result } = await world.decide(
        request.requestId, 'FORCE_ALLOW', 'NOT_AGREED', { validUntilUtc: options.validUntilUtc || '' }
      );
      return { request, decision: result, authorization: result.dynamicAuthorization };
    },
  };
  return world;
}

module.exports = { DEFAULT_PROFILES, createDiasWorld, profileFor };
