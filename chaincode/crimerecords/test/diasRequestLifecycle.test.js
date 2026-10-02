'use strict';

/**
 * Plan step 7: a pending request ends. It carries a review deadline taken from
 * an on-chain parameter; after the deadline no decision is accepted, and an
 * explicit transaction records the expiry. The requester may cancel while it is
 * pending. Every terminal state persists through its own successful transaction,
 * because a rejected transaction writes nothing (design §8).
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const SUBMITTED_AT = '2026-08-05T12:00:00.000Z';
const DEFAULT_DEADLINE = '2026-08-08T12:00:00.000Z';
const AFTER_DEADLINE = '2026-08-08T12:00:01.000Z';

describe('DIAS pending-request lifecycle (plan step 7)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  async function pending(options = {}) {
    const { result } = await world.submit(INSPECTOR, options);
    expect(result.status).to.equal('awaiting-auditor');
    return result;
  }

  describe('review deadline', () => {
    it('gives a pending request the default 72-hour deadline and an automatic grant none', async () => {
      const request = await pending();
      expect(request.submittedAtUtc).to.equal(SUBMITTED_AT);
      expect(request.reviewDeadlineUtc).to.equal(DEFAULT_DEADLINE);
      await world.createAuthorization(INSPECTOR, { recordId: 'FIR-2' });
      const { result: reused } = await world.submit(INSPECTOR, { recordId: 'FIR-2' });
      expect(reused.status).to.equal('granted');
      expect(reused.reviewDeadlineUtc).to.equal(null);
    });

    it('takes the deadline from the on-chain parameter set by an active district head', async () => {
      const { result } = await world.setParameters({ pendingReviewTtlSeconds: 3600 });
      expect(result).to.include({ pendingReviewTtlSeconds: 3600 });
      expect((await pending()).reviewDeadlineUtc).to.equal('2026-08-05T13:00:00.000Z');
    });

    it('refuses parameters from anyone else and out-of-range or unknown values', async () => {
      await expect(world.setParameters({ pendingReviewTtlSeconds: 3600 }, { caller: INSPECTOR }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      for (const bad of [{ pendingReviewTtlSeconds: 59 }, { pendingReviewTtlSeconds: 2592001 },
        { pendingReviewTtlSeconds: 90.5 }, { pendingReviewTtlSeconds: '3600' }, { other: 1 }]) {
        await expect(world.setParameters(bad), JSON.stringify(bad)).to.be.rejected;
      }
    });
  });

  describe('expiry', () => {
    it('rejects a decision after the deadline without writing anything', async () => {
      const request = await pending();
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW', { timestamp: AFTER_DEADLINE }))
        .to.be.rejectedWith(/DIAS_REQUEST_EXPIRED/);
      expect(world.readRequest(request.requestId).status).to.equal('awaiting-auditor');
      expect(world.readState('diasAuditorDecision', request.requestId)).to.equal(null);
    });

    it('records the expiry through its own transaction once the deadline has passed', async () => {
      const request = await pending();
      await expect(world.expire(request.requestId, { timestamp: '2026-08-08T11:59:59.000Z' }))
        .to.be.rejectedWith(/not due to expire until 2026-08-08T12:00:00.000Z/);
      const { result } = await world.expire(request.requestId, { timestamp: AFTER_DEADLINE });
      expect(result.request).to.include({ status: 'expired', auditorReviewStatus: 'EXPIRED' });
      expect(result.accessOutcome).to.include({ outcome: 'EXPIRED', basis: 'REVIEW_DEADLINE_PASSED' });
      expect(world.readRequest(request.requestId).status).to.equal('expired');
      expect(world.eventTypes(request.requestId)).to.deep.equal([
        'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'REQUEST_EXPIRED', 'ACCESS_OUTCOME_RECORDED',
      ]);
      expect(world.readState('accessDecision', 'FIR-1', result.accessOutcome.outcomeId))
        .to.include({ status: 'expired', decision: 'deny', decisionAuthority: 'review-deadline' });
      await expect(world.expire(request.requestId, { timestamp: AFTER_DEADLINE }))
        .to.be.rejectedWith(/is not awaiting-auditor \(status: expired\)/);
    });

    it('refuses a late decision on an expired request', async () => {
      const request = await pending();
      await world.expire(request.requestId, { timestamp: AFTER_DEADLINE });
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW', { timestamp: AFTER_DEADLINE }))
        .to.be.rejectedWith(/is not awaiting-auditor \(status: expired\)/);
    });

    it('lets the requester ask again after an expiry', async () => {
      const request = await pending();
      await world.expire(request.requestId, { timestamp: AFTER_DEADLINE });
      const { result: again } = await world.submit(INSPECTOR, { timestamp: AFTER_DEADLINE });
      expect(again.status).to.equal('awaiting-auditor');
      expect(again.requestId).to.not.equal(request.requestId);
    });
  });

  describe('cancellation', () => {
    it('lets only the requester cancel a pending request', async () => {
      const request = await pending();
      await expect(world.cancel(request.requestId, { caller: CALLERS.constable }))
        .to.be.rejectedWith(/only the requester can cancel/);
      const { result } = await world.cancel(request.requestId);
      expect(result.request.status).to.equal('cancelled');
      expect(result.accessOutcome).to.include({ outcome: 'CANCELLED', basis: 'REQUESTER_CANCELLED' });
      expect(world.eventTypes(request.requestId).slice(-2))
        .to.deep.equal(['REQUEST_CANCELLED', 'ACCESS_OUTCOME_RECORDED']);
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY'))
        .to.be.rejectedWith(/is not awaiting-auditor \(status: cancelled\)/);
    });

    it('cannot cancel a request that is already decided', async () => {
      const request = await pending();
      await world.decide(request.requestId, 'FORCE_DENY', 'DENY');
      await expect(world.cancel(request.requestId)).to.be.rejectedWith(/is not awaiting-auditor \(status: denied\)/);
    });
  });

  it('never releases anything for an expired or cancelled request', async () => {
    const expired = await pending();
    const { result } = await world.expire(expired.requestId, { timestamp: AFTER_DEADLINE });
    await expect(world.run(INSPECTOR, world.nextTx('DOCREQ'), (ctx) => world.contracts.records
      .CreateFullDocumentRequest(ctx, 'FIR-1', result.accessOutcome.outcomeId)))
      .to.be.rejectedWith(/status is 'expired'/);
  });
});
