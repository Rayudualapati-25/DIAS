'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const FORMER_AI_IDENTITY = Object.freeze({
  identityId: 'llm-decider',
  mspId: 'AIOrgMSP',
  attrs: { role: 'llm-decider', credentialStatus: 'active' },
});

describe('DIAS access workflow safeguards', () => {
  let world;
  const call = (caller, fn, tx) => world.run(caller, tx || world.nextTx('CALL'), fn)
    .then(({ result }) => result);

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  describe('request submission', () => {
    it('commits the structured action and purpose and keeps identity out of the verified request', async () => {
      const { result } = await world.submit(INSPECTOR, {
        action: 'export', purpose: 'prosecution', emergencyFlag: true,
      });
      expect(result.verifiedRequest.request).to.deep.equal({
        action: 'export', purpose: 'prosecution', emergencyFlag: true, approvalTokenPresent: false,
      });
      expect(result.verifiedRequest.requester).to.not.have.any.keys('username', 'enrollmentId');
      expect(result.requester).to.include({
        username: 'insp.test', stableUserId: 'PoliceMSP::insp.test', organization: 'police',
      });
      expect(result).to.not.have.any.keys('justificationHash', 'justificationStorage', 'policyBundleAtSubmission');
    });

    it('rejects invalid request fields', async () => {
      await expect(world.submit(INSPECTOR, { purpose: 'curiosity' })).to.be.rejectedWith(/'purpose' must be one of/);
      await expect(world.submit(INSPECTOR, { action: 'delete' })).to.be.rejectedWith(/'action' must be one of/);
      await expect(world.submit(INSPECTOR, { recordId: 'FIR 1' })).to.be.rejectedWith(/recordId has invalid format/);
      await expect(world.submit(INSPECTOR, { recordId: 'FIR-404' })).to.be.rejectedWith(/record 'FIR-404' does not exist/);
      const create = (body) => (ctx) => world.contracts.access.CreateAccessRequest(ctx, 'FIR-1', body);
      await expect(world.run(INSPECTOR, 'TX-UNKNOWN', create('{"action":"view","purpose":"investigation","role":"sp"}')))
        .to.be.rejectedWith(/unknown fields not permitted: role/);
      await expect(world.run(INSPECTOR, 'TX-BADJSON', create('{'))).to.be.rejectedWith(/must be valid JSON/);
    });

    it('binds the request to the certificate-matched UserProfile', async () => {
      const stranger = { identityId: 'ghost.test', mspId: 'PoliceMSP', attrs: { ...INSPECTOR.attrs } };
      await expect(world.submit(stranger)).to.be.rejectedWith(/no UserProfile/);
      const mismatched = { ...INSPECTOR, attrs: { ...INSPECTOR.attrs, clearance: 'low' } };
      await expect(world.submit(mismatched)).to.be.rejectedWith(/certificate clearance does not match/);
      const roleless = { ...INSPECTOR, attrs: { ...INSPECTOR.attrs, role: undefined } };
      await expect(world.submit(roleless)).to.be.rejectedWith(/no role attribute/);
    });
  });

  describe('auditor decision stage', () => {
    it('allows only AuditMSP district heads, with a valid decision and LLM agreement', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED', { caller: INSPECTOR }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED', { caller: CALLERS.districtJudge }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED', { caller: FORMER_AI_IDENTITY }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      const stationHead = {
        identityId: 'ci.test', mspId: 'AuditMSP',
        attrs: { role: 'circle-inspector', jurisdiction: 'district-north', clearance: 'high', credentialStatus: 'active' },
      };
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED', { caller: stationHead }))
        .to.be.rejectedWith(/requires role in/);
      await expect(world.decide(request.requestId, 'MAYBE', 'AGREED'))
        .to.be.rejectedWith(/one of \[FORCE_ALLOW, FORCE_DENY\]/);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'PARTLY'))
        .to.be.rejectedWith(/llmAgreement must be one of \[AGREED, NOT_AGREED, NO_RECOMMENDATION\]/);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', ''))
        .to.be.rejectedWith(/llmAgreement must be one of/);
      const { result } = await world.decide(request.requestId, 'force-allow', 'not agreed');
      expect(result.auditorDecision).to.include({ decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' });
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'AGREED'))
        .to.be.rejectedWith(/is not awaiting-auditor/);
    });

    it('prevents a requester from deciding their own request', async () => {
      const { result: request } = await world.submit(CALLERS.auditor);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'NOT_AGREED'))
        .to.be.rejectedWith(/cannot decide their own request/);
    });

    it('rejects a decision when governed facts changed after the request', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const profile = world.readState('user', 'insp.test');
      await world.putState('user', ['insp.test'], { ...profile, credentialStatus: 'suspended' });
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED'))
        .to.be.rejectedWith(/verified request facts changed/);
    });

    it('bounds revocation reasons and identifiers', async () => {
      const { authorization } = await world.createAuthorization();
      await expect(world.revoke(authorization.authorizationId, 'r'.repeat(501)))
        .to.be.rejectedWith(/at most 500 characters/);
      await expect(world.revoke('AUTH bad', 'reason')).to.be.rejectedWith(/authorizationId has invalid format/);
      await expect(world.revoke('AUTH-missing', 'reason')).to.be.rejectedWith(/does not exist/);
    });
  });

  describe('read access', () => {
    it('limits a request to its requester and district heads', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const read = (ctx) => world.contracts.access.GetRequest(ctx, request.requestId);
      for (const caller of [INSPECTOR, CALLERS.auditor]) {
        expect((await call(caller, read)).requestId).to.equal(request.requestId);
      }
      for (const caller of [CALLERS.constable, FORMER_AI_IDENTITY]) {
        await expect(call(caller, read)).to.be.rejectedWith(/belongs to a different identity/);
      }
      await expect(call(INSPECTOR, (ctx) => world.contracts.access.GetRequest(ctx, 'REQ 1')))
        .to.be.rejectedWith(/invalid format/);
    });

    it('shows district heads the pending queue with the committed request only', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const queue = (ctx) => world.contracts.access.QueryPendingAuditorRequests(ctx);
      await expect(call(INSPECTOR, queue)).to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      const pending = await call(CALLERS.auditor, queue);
      expect(pending).to.have.length(1);
      expect(Object.keys(pending[0])).to.deep.equal(['request']);
      expect(pending[0].request.requestId).to.equal(request.requestId);
      const review = await call(CALLERS.auditor, (ctx) => world.contracts.access.GetAuditorReview(ctx, request.requestId));
      expect(Object.keys(review)).to.deep.equal(['request']);
      await world.decide(request.requestId, 'FORCE_DENY', 'AGREED');
      expect(await call(CALLERS.auditor, queue)).to.deep.equal([]);
    });

    it('lets district heads query authorizations and their history', async () => {
      const { authorization } = await world.createAuthorization();
      await world.revoke(authorization.authorizationId, 'Tasking ended.');
      const query = (status) => (ctx) => world.contracts.access.QueryDynamicAuthorizations(ctx, status);
      expect((await call(CALLERS.auditor, query('revoked'))).map((item) => item.authorizationId))
        .to.deep.equal([authorization.authorizationId]);
      expect(await call(CALLERS.auditor, query('active'))).to.deep.equal([]);
      expect(await call(CALLERS.auditor, query('all'))).to.have.length(1);
      await expect(call(CALLERS.auditor, query('pending'))).to.be.rejectedWith(/status must be one of/);
      const detail = await call(CALLERS.auditor, (ctx) => world.contracts.access.GetDynamicAuthorization(ctx, authorization.authorizationId));
      expect(detail.events.map((event) => event.eventType))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED', 'DYNAMIC_AUTHORIZATION_REVOKED']);
      const history = await call(CALLERS.auditor, (ctx) => world.contracts.access.GetDynamicAuthorizationHistory(ctx, authorization.authorizationId));
      expect(history.history.map((entry) => entry.value.status)).to.deep.equal(['active', 'revoked']);
      await expect(call(INSPECTOR, (ctx) => world.contracts.access.GetDynamicAuthorization(ctx, authorization.authorizationId)))
        .to.be.rejectedWith(/requires membership/);
      await expect(call(CALLERS.auditor, (ctx) => world.contracts.access.GetDynamicAuthorizationHistory(ctx, 'AUTH bad')))
        .to.be.rejectedWith(/invalid format/);
    });

    it('limits access decisions to their subject and district heads', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED');
      const decisionId = result.accessOutcome.outcomeId;
      const get = (ctx) => world.contracts.access.GetDecision(ctx, 'FIR-1', decisionId);
      expect((await call(INSPECTOR, get)).status).to.equal('granted');
      await expect(call(CALLERS.constable, get)).to.be.rejectedWith(/different identity/);
      const byRecord = (ctx) => world.contracts.access.QueryDecisionsByRecord(ctx, 'FIR-1');
      expect(await call(CALLERS.constable, byRecord)).to.deep.equal([]);
      expect(await call(CALLERS.auditor, byRecord)).to.have.length(1);
      await expect(call(INSPECTOR, (ctx) => world.contracts.access.GetDecision(ctx, 'FIR-1', 'bad id')))
        .to.be.rejectedWith(/valid formats/);
    });
  });
});
