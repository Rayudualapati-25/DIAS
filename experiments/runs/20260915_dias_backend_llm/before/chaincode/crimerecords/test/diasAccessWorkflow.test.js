'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { OUTPUTS, createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const REVIEWED_STAGES = Object.freeze([
  'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'POLICY_CONTEXT_ASSEMBLED',
  'LLM_RECOMMENDATION_RECORDED', 'AUDITOR_DECISION_RECORDED', 'ACCESS_OUTCOME_RECORDED',
]);
const stagesOf = (events) => events.map((event) => event.eventType);

describe('DIAS access workflow', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  describe('scenario A: LLM ALLOW, auditor FORCE_ALLOW', () => {
    it('grants access, records every stage, and creates no dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      expect(request).to.include({ status: 'awaiting-recommendation', processingPath: 'llm-auditor' });
      expect(request.requestId).to.match(/^REQ-/);
      expect(request.dynamicAuthorizationCheck.outcome).to.equal('NO_AUTHORIZATION');

      const { result: recommendation } = await world.recommend(request.requestId, OUTPUTS.allow);
      expect(recommendation).to.include({
        generationStatus: 'OK', recommendation: 'ALLOW', reasonCode: 'POLICY_SATISFIED',
      });
      expect(recommendation.terminology).to.match(/not an access decision/);
      expect(world.readRequest(request.requestId).status).to.equal('awaiting-auditor');

      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW');
      expect(result.auditorDecision).to.include({
        decision: 'FORCE_ALLOW', override: false, authorizationCreated: false,
      });
      expect(result.accessOutcome).to.include({ outcome: 'GRANTED', basis: 'AUDITOR_DECISION' });
      expect(result.dynamicAuthorization).to.equal(null);
      expect(world.eventTypes(request.requestId)).to.deep.equal([...REVIEWED_STAGES]);
      expect(world.readState('accessDecision', 'FIR-1', result.accessOutcome.outcomeId))
        .to.include({ status: 'granted', decisionAuthority: 'auditor', action: 'view' });
      expect(world.readRequest(request.requestId))
        .to.include({ status: 'granted', auditorReviewStatus: 'FORCE_ALLOW' });
    });
  });

  describe('scenario B: LLM DENY, auditor FORCE_DENY', () => {
    it('denies access without creating a dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await world.recommend(request.requestId, OUTPUTS.deny);
      const { result } = await world.decide(request.requestId, 'FORCE_DENY');
      expect(result.accessOutcome).to.include({ outcome: 'DENIED', basis: 'AUDITOR_DECISION' });
      expect(result.auditorDecision.override).to.equal(false);
      expect(result.dynamicAuthorization).to.equal(null);
      expect(world.eventTypes(request.requestId)).to.deep.equal([...REVIEWED_STAGES]);
      expect(world.readRequest(request.requestId).status).to.equal('denied');
      expect(world.readState('accessDecision', 'FIR-1', result.accessOutcome.outcomeId).status)
        .to.equal('denied');
    });
  });

  describe('scenario C: LLM DENY, auditor FORCE_ALLOW', () => {
    it('requires an override reason before recording the decision', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await world.recommend(request.requestId, OUTPUTS.deny);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', '   '))
        .to.be.rejectedWith(/override reason is required/);
      expect(world.readRequest(request.requestId).status).to.equal('awaiting-auditor');
    });

    it('grants access and creates an exact-record dynamic authorization with provenance', async () => {
      const { request, decision, authorization } = await world.createAuthorization();
      expect(decision.accessOutcome).to.include({
        outcome: 'GRANTED', basis: 'AUDITOR_DECISION', createdAuthorizationId: authorization.authorizationId,
      });
      expect(decision.auditorDecision).to.include({ override: true, authorizationCreated: true });
      expect(authorization).to.include({
        status: 'active', generation: 1, stateVersion: 1, originatingRequestId: request.requestId,
      });
      expect(authorization.scope).to.deep.equal({
        scopeVersion: 'dias-authorization-scope-exact-record-v1',
        stableUserId: 'PoliceMSP::insp.test',
        recordId: 'FIR-1',
        caseId: 'CASE-1',
        action: 'view',
        purpose: 'investigation',
      });
      expect(authorization.originalLlmRecommendation.recommendation).to.equal('DENY');
      expect(authorization.auditorDecision.decision).to.equal('FORCE_ALLOW');
      expect(authorization.createdBy).to.include({ username: 'sp.test', mspId: 'AuditMSP', role: 'sp' });
      expect(world.eventTypes(request.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'POLICY_CONTEXT_ASSEMBLED',
        'LLM_RECOMMENDATION_RECORDED', 'AUDITOR_DECISION_RECORDED', 'DYNAMIC_AUTHORIZATION_CREATED',
        'ACCESS_OUTCOME_RECORDED',
      ]);
      expect(stagesOf(world.authorizationEvents(authorization.authorizationId)))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED']);
      expect(world.readRequest(request.requestId).createdAuthorizationId)
        .to.equal(authorization.authorizationId);
    });
  });

  describe('scenario D: reuse of an active dynamic authorization', () => {
    it('grants a repeat request with the LLM and the auditor recorded as skipped', async () => {
      const { authorization, decision } = await world.createAuthorization();
      const { ctx, result: repeat } = await world.submit(INSPECTOR);
      expect(repeat).to.include({
        status: 'granted', processingPath: 'dynamic-authorization',
        llmRecommendationStatus: 'SKIPPED', auditorReviewStatus: 'SKIPPED',
      });
      expect(repeat.dynamicAuthorizationCheck).to.include({
        outcome: 'MATCH', matched: true, authorizationId: authorization.authorizationId,
      });
      expect(world.eventTypes(repeat.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'LLM_RECOMMENDATION_SKIPPED',
        'AUDITOR_REVIEW_SKIPPED', 'ACCESS_OUTCOME_RECORDED',
      ]);
      const outcome = world.readState('diasAccessOutcome', repeat.requestId);
      expect(outcome).to.include({
        outcome: 'GRANTED',
        basis: 'DYNAMIC_AUTHORIZATION',
        authorizationId: authorization.authorizationId,
        originatingRequestId: authorization.originatingRequestId,
        originatingAuditorDecisionId: decision.auditorDecision.auditorDecisionId,
      });
      expect(world.readState('diasLlmRecommendation', repeat.requestId)).to.equal(null);
      expect(world.readState('accessDecision', 'FIR-1', outcome.outcomeId).decisionAuthority)
        .to.equal('dynamic-authorization');
      expect(JSON.parse(ctx._events[0].payload)).to.include({ nextStep: null, outcome: 'GRANTED' });
      const skipped = world.requestEvents(repeat.requestId)
        .find((event) => event.eventType === 'LLM_RECOMMENDATION_SKIPPED');
      expect(skipped.data).to.deep.equal({
        status: 'SKIPPED', reason: 'ACTIVE_DYNAMIC_AUTHORIZATION', authorizationId: authorization.authorizationId,
      });
    });
  });

  describe('scenario E: no broad reuse', () => {
    it('does not reuse the authorization for another record, action, purpose, or user', async () => {
      await world.createAuthorization();
      const variants = [
        [INSPECTOR, { recordId: 'FIR-2' }],
        [INSPECTOR, { action: 'export' }],
        [INSPECTOR, { purpose: 'audit-review' }],
        [CALLERS.constable, {}],
      ];
      for (const [caller, options] of variants) {
        const { result } = await world.submit(caller, options);
        expect(result.status, JSON.stringify(options)).to.equal('awaiting-recommendation');
        expect(result.dynamicAuthorizationCheck.outcome, JSON.stringify(options)).to.equal('NO_AUTHORIZATION');
      }
    });

    it('does not reuse the authorization after a governed fact changes', async () => {
      await world.createAuthorization();
      await world.putState('case', ['CASE-1'], {
        docType: 'case', caseId: 'CASE-1', owningAgency: 'police', jurisdiction: 'district-north',
        status: 'open', assignedUsers: ['insp.test'], protectedClassifications: [],
      });
      const { result } = await world.submit(INSPECTOR);
      expect(result.dynamicAuthorizationCheck.outcome).to.equal('CONDITIONS_CHANGED');
      expect(result.status).to.equal('awaiting-recommendation');
    });
  });

  describe('scenario F: explicit revocation', () => {
    it('requires a district head and a reason, records the change, and stops reuse', async () => {
      const { authorization } = await world.createAuthorization();
      await expect(world.revoke(authorization.authorizationId, 'no longer needed', { caller: INSPECTOR }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      await expect(world.revoke(authorization.authorizationId, ''))
        .to.be.rejectedWith(/revocation reason is required/);
      const { result: revoked } = await world.revoke(authorization.authorizationId, 'Tasking ended.');
      expect(revoked).to.include({ status: 'revoked', stateVersion: 2, revocationReason: 'Tasking ended.' });
      const events = world.authorizationEvents(authorization.authorizationId);
      expect(stagesOf(events)).to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED', 'DYNAMIC_AUTHORIZATION_REVOKED']);
      expect(events[1].data).to.include({
        previousStatus: 'active', previousStateVersion: 1, newStatus: 'revoked', newStateVersion: 2,
      });
      await expect(world.revoke(authorization.authorizationId, 'again')).to.be.rejectedWith(/is not active/);
      const { result: later } = await world.submit(INSPECTOR);
      expect(later.dynamicAuthorizationCheck.outcome).to.equal('REVOKED');
      expect(later.status).to.equal('awaiting-recommendation');
    });

    it('creates a new generation when a revoked scope is approved again', async () => {
      const first = await world.createAuthorization();
      await world.revoke(first.authorization.authorizationId, 'Tasking ended.');
      const second = await world.createAuthorization();
      expect(second.authorization).to.include({
        generation: 2, supersedesAuthorizationId: first.authorization.authorizationId,
      });
      expect(world.readState('diasAuthorization', first.authorization.authorizationId).status).to.equal('revoked');
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck).to.include({
        outcome: 'MATCH', authorizationId: second.authorization.authorizationId,
      });
    });
  });

  describe('scenario G: recommendation unavailable', () => {
    it('records the failure without a recommendation and keeps the request reviewable', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result: failure } = await world.unavailable(request.requestId);
      expect(failure).to.include({
        generationStatus: 'UNAVAILABLE', recommendation: null, reasonCode: null, errorCode: 'server_unreachable',
      });
      expect(world.eventTypes(request.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'POLICY_CONTEXT_ASSEMBLED',
        'LLM_RECOMMENDATION_UNAVAILABLE',
      ]);
      expect(world.readRequest(request.requestId))
        .to.include({ status: 'awaiting-auditor', llmRecommendationStatus: 'UNAVAILABLE' });
      await expect(world.decide(request.requestId, 'FORCE_ALLOW')).to.be.rejectedWith(/override reason is required/);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'Model offline; verified manually.');
      expect(result.accessOutcome.outcome).to.equal('GRANTED');
      expect(result.dynamicAuthorization).to.equal(null);
      expect(result.auditorDecision.override).to.equal(true);
    });
  });

  describe('expiry', () => {
    it('stops reuse after validUntilUtc and records the expiry transition', async () => {
      const { authorization } = await world.createAuthorization(INSPECTOR, {
        validUntilUtc: '2026-08-06T00:00:00Z',
      });
      expect(authorization.validUntilUtc).to.equal('2026-08-06T00:00:00.000Z');
      const { result: before } = await world.submit(INSPECTOR);
      expect(before.dynamicAuthorizationCheck.outcome).to.equal('MATCH');
      const { result: after } = await world.submit(INSPECTOR, { timestamp: '2026-08-07T09:00:00Z' });
      expect(after.dynamicAuthorizationCheck.outcome).to.equal('EXPIRED');
      expect(after.status).to.equal('awaiting-recommendation');
      expect(world.readState('diasAuthorization', authorization.authorizationId))
        .to.include({ status: 'expired', stateVersion: 2 });
      expect(stagesOf(world.authorizationEvents(authorization.authorizationId)))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED', 'DYNAMIC_AUTHORIZATION_EXPIRED']);
    });

    it('rejects an expiry when no dynamic authorization is created', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await world.recommend(request.requestId, OUTPUTS.allow);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', '', { validUntilUtc: '2026-09-01T00:00:00Z' }))
        .to.be.rejectedWith(/applies only when a dynamic authorization is created/);
    });
  });

  describe('FORCE_DENY', () => {
    it('requires a reason to override an ALLOW and never revokes other authorizations', async () => {
      const { authorization } = await world.createAuthorization();
      const { result: other } = await world.submit(INSPECTOR, { recordId: 'FIR-2' });
      await world.recommend(other.requestId, OUTPUTS.allow);
      await expect(world.decide(other.requestId, 'FORCE_DENY')).to.be.rejectedWith(/override reason is required/);
      const { result } = await world.decide(other.requestId, 'FORCE_DENY', 'Record is part of a restricted inquiry.');
      expect(result.accessOutcome.outcome).to.equal('DENIED');
      expect(world.readState('diasAuthorization', authorization.authorizationId).status).to.equal('active');
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck.outcome).to.equal('MATCH');
    });
  });

  describe('authority boundary', () => {
    it('records the LLM recommendation exactly as submitted, with no policy re-evaluation', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      expect(request.verifiedRequest.requester.assignedToRequestedCase).to.equal(false);
      const { result: recommendation } = await world.recommend(request.requestId, OUTPUTS.allow);
      expect(recommendation.recommendation).to.equal('ALLOW');
      expect(recommendation).to.not.have.any.keys(
        'validatedDecision', 'policyValidation', 'effectiveRecommendation', 'validatedReasonCode'
      );
      expect(world.readRequest(request.requestId).status).to.equal('awaiting-auditor');
    });
  });
});
