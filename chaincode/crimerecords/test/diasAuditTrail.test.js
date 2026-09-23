'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const AuditContract = require('../lib/auditContract');
const { CALLERS, RECORD_META, buildMockContext, cloneInto } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

const audit = new AuditContract();
const stagesOf = (events) => events.map((event) => event.eventType);

describe('AuditContract', () => {
  let world;
  const call = (caller, fn, tx) => world.run(caller, tx || world.nextTx('AUDITREAD'), fn)
    .then(({ result }) => result);
  const trail = (caller, requestId) => call(
    caller, (ctx) => world.contracts.audit.GetRequestAuditTrail(ctx, requestId)
  );

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  describe('GetRequestAuditTrail', () => {
    it('reconstructs a reviewed request that created a dynamic authorization', async () => {
      const { request, authorization } = await world.createAuthorization();
      const result = await trail(CALLERS.auditor, request.requestId);
      expect(result.viewer).to.equal('reviewer');
      expect(result.summary).to.include({
        requestId: request.requestId, requester: 'insp.test', action: 'view', recordId: 'FIR-1',
        status: 'granted', createdAuthorizationId: authorization.authorizationId,
      });
      expect(result.summary.dynamicAuthorization).to.deep.equal({ outcome: 'NO_AUTHORIZATION', authorizationId: null });
      expect(result.summary.auditor).to.include({
        username: 'sp.test', decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED',
      });
      expect(result.summary.outcome).to.include({ outcome: 'GRANTED', basis: 'AUDITOR_DECISION' });
      expect(result.transactions.map((transaction) => transaction.stages)).to.deep.equal([
        ['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED'],
        ['AUDITOR_DECISION_RECORDED', 'DYNAMIC_AUTHORIZATION_CREATED', 'ACCESS_OUTCOME_RECORDED'],
      ]);
      expect(new Set(result.transactions.map((transaction) => transaction.txId)).size).to.equal(2);
      expect(result.auditorDecision).to.include({ decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' });
      expect(result.dynamicAuthorizations).to.have.length(1);
      expect(result.dynamicAuthorizations[0].relation).to.equal('created-by-this-request');
      expect(stagesOf(result.dynamicAuthorizations[0].events)).to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED']);
      expect(result.requestKeyHistory).to.have.length(2);
      expect(result).to.not.have.any.keys('llmRecommendation', 'privateText');
      expect(result.provenanceSource).to.match(/Hyperledger Fabric/);
    });

    it('reconstructs a reused authorization with the auditor skipped, and a later revocation', async () => {
      const { authorization } = await world.createAuthorization();
      const { result: repeat } = await world.submit(CALLERS.inspector);
      await world.revoke(authorization.authorizationId, 'Tasking ended.');
      const result = await trail(CALLERS.auditor, repeat.requestId);
      expect(result.summary.dynamicAuthorization).to.deep.equal({
        outcome: 'MATCH', authorizationId: authorization.authorizationId,
      });
      expect(result.summary.auditor).to.deep.equal({ status: 'SKIPPED' });
      expect(result.summary.outcome).to.include({ outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION' });
      expect(result.transactions).to.have.length(1);
      expect(result.auditorDecision).to.equal(null);
      expect(result.dynamicAuthorizations[0].relation).to.equal('checked-by-this-request');
      expect(result.dynamicAuthorizations[0].authorization.status).to.equal('revoked');
      expect(stagesOf(result.dynamicAuthorizations[0].events))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED', 'DYNAMIC_AUTHORIZATION_REVOKED']);
    });

    it('lets the requester read their own trail and refuses other identities', async () => {
      const { request } = await world.createAuthorization();
      const own = await trail(CALLERS.inspector, request.requestId);
      expect(own.viewer).to.equal('requester');
      expect(own.summary.auditor).to.include({ decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' });
      await expect(trail(CALLERS.constable, request.requestId)).to.be.rejectedWith(/requires a reviewer or the requester/);
      await expect(trail(CALLERS.auditor, 'REQ-missing')).to.be.rejectedWith(/does not exist/);
      await expect(trail(CALLERS.auditor, 'REQ 1')).to.be.rejectedWith(/invalid format/);
    });
  });

  describe('record-level trail and verification', () => {
    it('lists the DIAS requests and release grants for a record', async () => {
      const { request } = await world.createAuthorization();
      const result = await call(CALLERS.auditor, (ctx) => world.contracts.audit.GetAuditTrail(ctx, 'FIR-1'));
      expect(result.requests.map((item) => item.requestId)).to.deep.equal([request.requestId]);
      expect(result.accessDecisions).to.have.length(1);
      expect(result.recordHistory).to.have.length(1);
      await expect(call(CALLERS.inspector, (ctx) => world.contracts.audit.GetAuditTrail(ctx, 'FIR-1')))
        .to.be.rejectedWith(/requires membership in/);
      await expect(call(CALLERS.auditor, (ctx) => world.contracts.audit.GetAuditTrail(ctx, 'FIR-404')))
        .to.be.rejectedWith(/does not exist/);
    });

    it('confirms a matching payload hash and flags a tampered one', async () => {
      const verify = (hash) => call(CALLERS.auditor, (ctx) => world.contracts.audit.VerifyRecordPayload(ctx, 'FIR-1', hash));
      expect((await verify(RECORD_META.contentHash)).match).to.equal(true);
      expect((await verify('f'.repeat(64))).match).to.equal(false);
      await expect(call(CALLERS.auditor, (ctx) => world.contracts.audit.VerifyRecordPayload(ctx, 'FIR-404', 'a'.repeat(64))))
        .to.be.rejectedWith(/does not exist/);
    });
  });

  describe('direct-ledger access events', () => {
    const asCaller = (caller, state) => {
      const ctx = buildMockContext(caller);
      cloneInto(state, ctx);
      return ctx;
    };

    it('derives the actor from the signing identity and stores the event', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      const event = JSON.parse(await audit.RecordAccessEvent(
        ctx, 'record.read', JSON.stringify({ recordId: 'FIR-1' }), 'ok', '200'));
      expect(event).to.include({ actorUsername: 'insp.test', actorMsp: 'PoliceMSP', action: 'record.read' });
      expect(ctx._events[0].name).to.equal('ApplicationAccessRecorded');
    });

    it('allows reviewers to query and rejects ordinary departments', async () => {
      const state = buildMockContext(CALLERS.inspector);
      await audit.RecordAccessEvent(state, 'record.read', '{}', 'ok', '200');
      const events = JSON.parse(await audit.QueryAccessEvents(asCaller(CALLERS.auditor, state), '50'));
      expect(events).to.have.length(1);
      await expect(audit.QueryAccessEvents(state, '50')).to.be.rejectedWith(/requires membership in/);
    });

    it('rejects malformed event fields and limits', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await expect(audit.RecordAccessEvent(ctx, 'bad action!', '{}', 'ok', '200')).to.be.rejectedWith(/action/);
      await expect(audit.RecordAccessEvent(ctx, 'record.read', '{}', 'maybe', '200')).to.be.rejectedWith(/outcome/);
      await expect(audit.RecordAccessEvent(ctx, 'record.read', '{}', 'ok', '999')).to.be.rejectedWith(/statusCode/);
      await expect(audit.RecordAccessEvent(ctx, 'record.read', '{', 'ok', '200')).to.be.rejectedWith(/valid JSON/);
      await expect(audit.RecordAccessEvent(ctx, 'record.read', JSON.stringify({ x: 'y'.repeat(2100) }), 'ok', '200'))
        .to.be.rejectedWith(/2048 byte limit/);
      await expect(audit.QueryAccessEvents(buildMockContext(CALLERS.auditor), '0')).to.be.rejectedWith(/limit/);
    });
  });
});
