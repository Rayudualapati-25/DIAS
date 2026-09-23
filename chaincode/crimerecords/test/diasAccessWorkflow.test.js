'use strict';

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const CONSTABLE = CALLERS.constable;
const REVIEWED_STAGES = Object.freeze([
  'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED',
  'AUDITOR_DECISION_RECORDED', 'ACCESS_OUTCOME_RECORDED',
]);
const stagesOf = (events) => events.map((event) => event.eventType);

describe('DIAS access workflow', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  describe('request log', () => {
    it('records who asked for which record and waits for the auditor', async () => {
      const { ctx, result: request } = await world.submit(INSPECTOR);
      expect(request.requestId).to.match(/^REQ-/);
      expect(request).to.include({
        status: 'awaiting-auditor', processingPath: 'auditor-review', recordId: 'FIR-1', caseId: 'CASE-1',
        action: 'view', purpose: 'investigation', auditorReviewStatus: 'PENDING', llmAgreement: null,
      });
      expect(request.requester).to.include({
        username: 'insp.test', stableUserId: 'PoliceMSP::insp.test', mspId: 'PoliceMSP', role: 'inspector',
      });
      expect(request.dynamicAuthorizationCheck.outcome).to.equal('NO_AUTHORIZATION');
      expect(world.eventTypes(request.requestId))
        .to.deep.equal(['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED']);
      expect(world.requestEvents(request.requestId)[0].data).to.include({
        username: 'insp.test', recordId: 'FIR-1', caseId: 'CASE-1', action: 'view', purpose: 'investigation',
      });
      expect(JSON.parse(ctx._events[0].payload)).to.include({ nextStep: 'AUDITOR_DECISION' });
    });

    it('writes nothing about the LLM or the justification to the ledger', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await world.decide(request.requestId, 'FORCE_ALLOW', 'NOT_AGREED');
      const ledgerText = [...world.ledger._state.keys(), ...world.ledger._state.values()].join('\n');
      expect(ledgerText).to.not.match(/recommendation|justification|provenance|attestation|llm-decider/i);
      expect(world.ledger._privateState.size).to.equal(0);
    });
  });

  describe('decision log: auditor FORCE_ALLOW that agreed with an LLM ALLOW', () => {
    it('grants access, records AGREED, and creates no dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED');
      expect(result.auditorDecision).to.include({
        requestId: request.requestId, recordId: 'FIR-1', decision: 'FORCE_ALLOW', llmAgreement: 'AGREED',
        authorizationCreated: false,
      });
      expect(result.auditorDecision.auditor).to.include({ username: 'sp.test', mspId: 'AuditMSP', role: 'sp' });
      expect(result.accessOutcome).to.include({ outcome: 'GRANTED', basis: 'AUDITOR_DECISION' });
      expect(result.dynamicAuthorization).to.equal(null);
      expect(world.eventTypes(request.requestId)).to.deep.equal([...REVIEWED_STAGES]);
      expect(world.readState('accessDecision', 'FIR-1', result.accessOutcome.outcomeId))
        .to.include({ status: 'granted', decisionAuthority: 'auditor', action: 'view' });
      expect(world.readRequest(request.requestId)).to.include({
        status: 'granted', auditorReviewStatus: 'FORCE_ALLOW', llmAgreement: 'AGREED',
      });
    });
  });

  describe('decision log: auditor FORCE_DENY that agreed with an LLM DENY', () => {
    it('denies access without creating a dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result } = await world.decide(request.requestId, 'FORCE_DENY', 'AGREED');
      expect(result.accessOutcome).to.include({ outcome: 'DENIED', basis: 'AUDITOR_DECISION' });
      expect(result.auditorDecision).to.include({ llmAgreement: 'AGREED', authorizationCreated: false });
      expect(result.dynamicAuthorization).to.equal(null);
      expect(world.eventTypes(request.requestId)).to.deep.equal([...REVIEWED_STAGES]);
      expect(world.readRequest(request.requestId)).to.include({ status: 'denied', llmAgreement: 'AGREED' });
      expect(world.readState('accessDecision', 'FIR-1', result.accessOutcome.outcomeId).status)
        .to.equal('denied');
    });
  });

  describe('decision log: auditor FORCE_ALLOW that did not agree with an LLM DENY', () => {
    it('grants access and creates an exact-record dynamic authorization', async () => {
      const { request, decision, authorization } = await world.createAuthorization();
      expect(decision.accessOutcome).to.include({
        outcome: 'GRANTED', basis: 'AUDITOR_DECISION', createdAuthorizationId: authorization.authorizationId,
      });
      expect(decision.auditorDecision).to.include({ llmAgreement: 'NOT_AGREED', authorizationCreated: true });
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
      expect(authorization.auditorDecision).to.deep.equal({
        auditorDecisionId: decision.auditorDecision.auditorDecisionId,
        decision: 'FORCE_ALLOW',
        llmAgreement: 'NOT_AGREED',
      });
      expect(authorization.createdBy).to.include({ username: 'sp.test', mspId: 'AuditMSP', role: 'sp' });
      expect(world.eventTypes(request.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'AUDITOR_DECISION_RECORDED',
        'DYNAMIC_AUTHORIZATION_CREATED', 'ACCESS_OUTCOME_RECORDED',
      ]);
      expect(stagesOf(world.authorizationEvents(authorization.authorizationId)))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED']);
      expect(world.readRequest(request.requestId).createdAuthorizationId)
        .to.equal(authorization.authorizationId);
    });
  });

  describe('decision log: auditor FORCE_DENY that did not agree with an LLM ALLOW', () => {
    it('denies access, records NOT_AGREED, and creates no dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result } = await world.decide(request.requestId, 'FORCE_DENY', 'NOT_AGREED');
      expect(result.accessOutcome.outcome).to.equal('DENIED');
      expect(result.auditorDecision).to.include({ llmAgreement: 'NOT_AGREED', authorizationCreated: false });
      expect(result.dynamicAuthorization).to.equal(null);
      await expect(world.decide(
        (await world.submit(INSPECTOR, { recordId: 'FIR-2' })).result.requestId,
        'FORCE_DENY', 'NOT_AGREED', { validUntilUtc: '2026-09-01T00:00:00Z' }
      )).to.be.rejectedWith(/applies only when a dynamic authorization is created/);
    });
  });

  describe('decision log: no LLM recommendation', () => {
    it('lets the auditor decide and never creates a dynamic authorization', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'NO_RECOMMENDATION', {
        validUntilUtc: '2026-09-01T00:00:00Z',
      })).to.be.rejectedWith(/applies only when a dynamic authorization is created/);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'NO_RECOMMENDATION');
      expect(result.accessOutcome.outcome).to.equal('GRANTED');
      expect(result.auditorDecision).to.include({ llmAgreement: 'NO_RECOMMENDATION', authorizationCreated: false });
      expect(result.dynamicAuthorization).to.equal(null);
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.status).to.equal('awaiting-auditor');
    });
  });

  describe('public decision log', () => {
    it('lets any signed-in member read who asked for what and what was decided', async () => {
      const granted = (await world.submit(INSPECTOR)).result;
      await world.decide(granted.requestId, 'FORCE_ALLOW', 'NOT_AGREED');
      const denied = (await world.submit(CONSTABLE, { recordId: 'FIR-2' })).result;
      await world.decide(denied.requestId, 'FORCE_DENY', 'AGREED');

      const { result: entries } = await world.run(CONSTABLE, world.nextTx('QUERY'),
        (ctx) => world.contracts.access.QueryAccessDecisions(ctx, '50'));

      expect(entries).to.have.length(2);
      const first = entries.find((entry) => entry.requestId === granted.requestId);
      expect(first).to.include({
        recordId: 'FIR-1', caseId: 'CASE-1', action: 'view', purpose: 'investigation',
        outcome: 'GRANTED', basis: 'AUDITOR_DECISION', decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED',
      });
      expect(first.requester).to.include({ username: 'insp.test', organization: 'police', role: 'inspector' });
      expect(first.auditor).to.include({ username: 'sp.test', role: 'sp' });
      expect(first.createdAuthorizationId).to.match(/^AUTH-/);
      // Nothing about the LLM's own answer, and no identity hashes.
      expect(JSON.stringify(entries)).to.not.match(/identityHash|reasonCode|recommendation"/i);
      expect(entries.find((entry) => entry.requestId === denied.requestId))
        .to.include({ outcome: 'DENIED', decision: 'FORCE_DENY', llmAgreement: 'AGREED' });
    });

    it('shows an automatic grant as decided by its dynamic authorization', async () => {
      const { authorization } = await world.createAuthorization();
      const repeat = (await world.submit(INSPECTOR)).result;
      expect(repeat.status).to.equal('granted');
      const { result: entries } = await world.run(CONSTABLE, world.nextTx('QUERY'),
        (ctx) => world.contracts.access.QueryAccessDecisions(ctx, '50'));
      const automatic = entries.find((entry) => entry.requestId === repeat.requestId);
      expect(automatic).to.include({
        outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION', decision: null, llmAgreement: null,
        authorizationId: authorization.authorizationId,
      });
      expect(automatic.auditor).to.equal(null);
    });

    it('returns the newest entries first and refuses an out-of-range limit', async () => {
      const times = { 'FIR-1': '2026-09-01T09:00:00.000Z', 'FIR-2': '2026-09-01T10:00:00.000Z' };
      for (const recordId of ['FIR-1', 'FIR-2']) {
        const request = (await world.submit(INSPECTOR, { recordId })).result;
        await world.decide(request.requestId, 'FORCE_DENY', 'AGREED', { timestamp: times[recordId] });
      }
      const { result: entries } = await world.run(INSPECTOR, world.nextTx('QUERY'),
        (ctx) => world.contracts.access.QueryAccessDecisions(ctx, '1'));
      expect(entries).to.have.length(1);
      expect(entries[0].recordId).to.equal('FIR-2');
      await expect(world.run(INSPECTOR, world.nextTx('QUERY'),
        (ctx) => world.contracts.access.QueryAccessDecisions(ctx, '0')))
        .to.be.rejectedWith(/limit must be an integer from 1 to 500/);
    });
  });

  describe('reuse of an active dynamic authorization', () => {
    it('grants a repeat request with the auditor recorded as skipped', async () => {
      const { authorization, decision } = await world.createAuthorization();
      const { ctx, result: repeat } = await world.submit(INSPECTOR);
      expect(repeat).to.include({
        status: 'granted', processingPath: 'dynamic-authorization', auditorReviewStatus: 'SKIPPED',
      });
      expect(repeat.dynamicAuthorizationCheck).to.include({
        outcome: 'MATCH', matched: true, authorizationId: authorization.authorizationId,
      });
      expect(world.eventTypes(repeat.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'AUDITOR_REVIEW_SKIPPED',
        'ACCESS_OUTCOME_RECORDED',
      ]);
      const outcome = world.readState('diasAccessOutcome', repeat.requestId);
      expect(outcome).to.include({
        outcome: 'GRANTED',
        basis: 'DYNAMIC_AUTHORIZATION',
        authorizationId: authorization.authorizationId,
        originatingRequestId: authorization.originatingRequestId,
        originatingAuditorDecisionId: decision.auditorDecision.auditorDecisionId,
      });
      expect(world.readState('diasAuditorDecision', repeat.requestId)).to.equal(null);
      expect(world.readState('accessDecision', 'FIR-1', outcome.outcomeId).decisionAuthority)
        .to.equal('dynamic-authorization');
      expect(JSON.parse(ctx._events[0].payload)).to.include({ nextStep: null, outcome: 'GRANTED' });
      const skipped = world.requestEvents(repeat.requestId)
        .find((event) => event.eventType === 'AUDITOR_REVIEW_SKIPPED');
      expect(skipped.data).to.deep.equal({
        status: 'SKIPPED',
        reason: 'ACTIVE_DYNAMIC_AUTHORIZATION',
        authorizationId: authorization.authorizationId,
        originatingRequestId: authorization.originatingRequestId,
        originatingAuditorDecisionId: decision.auditorDecision.auditorDecisionId,
      });
    });
  });

  describe('no broad reuse', () => {
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
        expect(result.status, JSON.stringify(options)).to.equal('awaiting-auditor');
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
      expect(result.status).to.equal('awaiting-auditor');
    });
  });

  describe('explicit revocation', () => {
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
      expect(later.status).to.equal('awaiting-auditor');
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
      expect(after.status).to.equal('awaiting-auditor');
      expect(world.readState('diasAuthorization', authorization.authorizationId))
        .to.include({ status: 'expired', stateVersion: 2 });
      expect(stagesOf(world.authorizationEvents(authorization.authorizationId)))
        .to.deep.equal(['DYNAMIC_AUTHORIZATION_CREATED', 'DYNAMIC_AUTHORIZATION_EXPIRED']);
    });

    it('rejects an expiry when no dynamic authorization is created', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'AGREED', { validUntilUtc: '2026-09-01T00:00:00Z' }))
        .to.be.rejectedWith(/applies only when a dynamic authorization is created/);
    });
  });

  describe('FORCE_DENY', () => {
    it('never revokes other authorizations', async () => {
      const { authorization } = await world.createAuthorization();
      const { result: other } = await world.submit(INSPECTOR, { recordId: 'FIR-2' });
      const { result } = await world.decide(other.requestId, 'FORCE_DENY', 'NOT_AGREED');
      expect(result.accessOutcome.outcome).to.equal('DENIED');
      expect(world.readState('diasAuthorization', authorization.authorizationId).status).to.equal('active');
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck.outcome).to.equal('MATCH');
    });
  });
});
