'use strict';

/**
 * Plan step 13 — who may read what (design §10).
 *
 * Record history, the evidence list and custody chain, and the decision log were
 * readable by every identity. Each is now refused or redacted for a caller
 * outside its column in the design's visibility table. A requester also learns
 * what the LLM recommended only once an auditor has decided (author's rule,
 * 2026-10-08).
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { DEFAULT_PROFILES, createDiasWorld, profileFor } = require('./diasTestWorld');

/** A caller like `base`, posted somewhere else. */
const posted = (base, attrs, identityId) => ({
  ...base, identityId: identityId || base.identityId, attrs: { ...base.attrs, ...attrs },
});

const otherStation = posted(CALLERS.constable, { station: 'PS-South' }, 'const.south');
const otherDistrictAnalyst = posted(CALLERS.analyst, { jurisdiction: 'district-south' }, 'analyst.south');
const otherDistrictJudge = posted(CALLERS.judge, { jurisdiction: 'district-south' }, 'judge.south');
const HASH = 'b'.repeat(64);

describe('DIAS privacy controls (plan step 13)', () => {
  let world;
  const read = (caller, fn) => world.run(caller, world.nextTx('READ'), fn).then(({ result }) => result);
  const records = () => world.contracts.records;
  const access = () => world.contracts.access;
  const audit = () => world.contracts.audit;

  beforeEach(async () => {
    world = await createDiasWorld().seed({
      profiles: [...DEFAULT_PROFILES, profileFor(CALLERS.judge, 'court')],
    });
  });

  describe('record history', () => {
    const history = (caller, recordId = 'FIR-1') => read(caller, (ctx) => records().GetRecordHistory(ctx, recordId));

    it('is readable by a reviewer and by the owning station', async () => {
      for (const caller of [CALLERS.auditor, CALLERS.districtJudge, CALLERS.judge, CALLERS.inspector, CALLERS.constable]) {
        const entries = await history(caller);
        expect(entries, caller.identityId).to.have.length(1);
        expect(entries[0].value.recordId).to.equal('FIR-1');
      }
    });

    it('is refused for another station, another organization, and a reviewer organization without the role', async () => {
      for (const caller of [otherStation, CALLERS.analyst, CALLERS.prosecutor]) {
        await expect(history(caller), caller.identityId)
          .to.be.rejectedWith(/unauthorized: GetRecordHistory requires a reviewer or the owning station/);
      }
    });

    it('is refused for an owning-station member whose credential is not active', async () => {
      const revoked = posted(CALLERS.inspector, { credentialStatus: 'revoked' }, 'insp.revoked');
      await expect(history(revoked))
        .to.be.rejectedWith(/unauthorized: GetRecordHistory requires a reviewer or the owning station/);
    });

    it('refuses a record that does not exist instead of returning an empty history', async () => {
      await expect(history(CALLERS.auditor, 'FIR-404')).to.be.rejectedWith(/does not exist/);
    });
  });

  describe('evidence list and custody chain', () => {
    const list = (caller) => read(caller, (ctx) => records().ListEvidence(ctx, 'FIR-1'));
    const custody = (caller) => read(caller, (ctx) => records().QueryEvidenceCustody(ctx, 'FIR-1', 'EV-1'));

    beforeEach(async () => {
      await world.run(CALLERS.analyst, world.nextTx('EVIDENCE'), (ctx) => {
        ctx.stub.getTransient = () => new Map();
        return records().AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', HASH, 'fingerprint lift', 'FSL-1');
      });
    });

    it('is readable by a reviewer and by same-district police, forensics, prosecution and court', async () => {
      for (const caller of [
        CALLERS.auditor, CALLERS.districtJudge, CALLERS.inspector, CALLERS.constable, CALLERS.analyst,
        CALLERS.prosecutor, CALLERS.judge,
      ]) {
        expect(await list(caller), caller.identityId).to.have.length(1);
        expect(await custody(caller), caller.identityId).to.be.an('array');
      }
    });

    it('is refused outside the record\'s district', async () => {
      for (const caller of [otherDistrictAnalyst, posted(CALLERS.inspector, { jurisdiction: 'district-south' }, 'insp.south')]) {
        await expect(list(caller), caller.identityId)
          .to.be.rejectedWith(/unauthorized: ListEvidence requires a reviewer or a same-district member/);
        await expect(custody(caller), caller.identityId)
          .to.be.rejectedWith(/unauthorized: QueryEvidenceCustody requires a reviewer or a same-district member/);
      }
    });

    it('is refused for a same-district member whose credential is not active', async () => {
      const suspended = posted(CALLERS.analyst, { credentialStatus: 'suspended' }, 'analyst.suspended');
      await expect(list(suspended)).to.be.rejectedWith(/unauthorized: ListEvidence/);
      await expect(custody(suspended)).to.be.rejectedWith(/unauthorized: QueryEvidenceCustody/);
    });

    it('scopes the private evidence detail to the district as well', async () => {
      const detail = (caller) => read(caller, (ctx) => {
        ctx.stub.getPrivateData = async () => Buffer.from('lift from the door handle');
        return records().GetEvidenceDetail(ctx, 'FIR-1', 'EV-1');
      });
      expect(await detail(CALLERS.analyst)).to.include({ evidenceId: 'EV-1', detail: 'lift from the door handle' });
      await expect(detail(otherDistrictAnalyst)).to.be.rejectedWith(/unauthorized: GetEvidenceDetail/);
      // The audit organisation is not a member of the evidence collection at all.
      await expect(detail(CALLERS.auditor)).to.be.rejectedWith(/requires membership/);
    });

    it('lets a seal-authority reviewer of another district read, because reviewers are not district-bound', async () => {
      expect(await list(otherDistrictJudge)).to.have.length(1);
    });
  });

  describe('decision log', () => {
    const log = (caller) => read(caller, (ctx) => access().QueryAccessDecisions(ctx, '50'));
    let request;

    beforeEach(async () => {
      ({ result: request } = await world.submit(CALLERS.inspector));
      await world.decide(request.requestId, 'FORCE_DENY', 'DENY');
    });

    it('is full for reviewers', async () => {
      for (const caller of [CALLERS.auditor, CALLERS.districtJudge, CALLERS.judge]) {
        const [entry] = await log(caller);
        expect(entry, caller.identityId).to.include({
          requestId: request.requestId, recordId: 'FIR-1', caseId: 'CASE-1', outcome: 'DENIED',
          decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED', generationStatus: 'OK',
        });
        expect(entry.requester).to.deep.equal({ username: 'insp.test', organization: 'police', role: 'inspector' });
        expect(entry.auditor).to.deep.equal({ username: 'sp.test', role: 'sp' });
        expect(entry).to.not.have.property('redacted');
      }
    });

    it('is redacted for everyone else, the requester included', async () => {
      // District-head role names exist in every organisation; in the police one confers no review.
      const policeSp = posted(CALLERS.inspector, { role: 'sp', station: 'PS-South' }, 'sp.police');
      await expect(read(policeSp, (ctx) => records().GetRecordHistory(ctx, 'FIR-1')))
        .to.be.rejectedWith(/unauthorized: GetRecordHistory/);
      for (const caller of [CALLERS.inspector, CALLERS.constable, CALLERS.analyst, CALLERS.prosecutor, policeSp]) {
        const entries = await log(caller);
        expect(entries, caller.identityId).to.deep.equal([{
          redacted: true,
          outcome: 'DENIED',
          basis: 'AUDITOR_DECISION',
          decision: 'FORCE_DENY',
          llmRecommendation: 'DENY',
          llmAgreement: 'AGREED',
          generationStatus: 'OK',
          action: 'view',
          purpose: 'investigation',
          requester: { organization: 'police' },
          decidedAtUtc: entries[0].decidedAtUtc,
        }]);
        // No identity, record, case, request or transaction identifier survives.
        expect(JSON.stringify(entries)).to.not.match(/insp\.test|sp\.test|FIR-1|CASE-1|REQ-|f{20}/);
      }
    });
  });

  describe('the recommendation, for the requester, follows the auditor decision', () => {
    const commitment = (caller, requestId) => read(caller, (ctx) => access().GetRecommendationCommitment(ctx, requestId));
    const trail = (caller, requestId) => read(caller, (ctx) => audit().GetRequestAuditTrail(ctx, requestId));
    let request;

    beforeEach(async () => {
      ({ result: request } = await world.submit(CALLERS.inspector));
      await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' }));
    });

    it('is withheld from the requester until an auditor has decided', async () => {
      const withheld = await commitment(CALLERS.inspector, request.requestId);
      expect(withheld).to.deep.equal({
        requestId: request.requestId, commitmentId: withheld.commitmentId, withheldUntilDecision: true,
      });
      expect(withheld.commitmentId).to.match(/^KAPPA-/);

      const view = await trail(CALLERS.inspector, request.requestId);
      expect(view.viewer).to.equal('requester');
      expect(view.recommendationCommitment).to.deep.equal(withheld);
      expect(view.summary.recommendation).to.deep.equal({
        commitmentId: withheld.commitmentId, withheldUntilDecision: true,
      });
      const committedEvent = view.lifecycle.find((event) => event.eventType === 'RECOMMENDATION_COMMITTED');
      expect(committedEvent.data).to.deep.equal({ commitmentId: withheld.commitmentId, withheldUntilDecision: true });
      expect(JSON.stringify(view)).to.not.match(/DENY|generationStatus/);
      expect(view.isRequester).to.equal(true);
    });

    it('is always visible to the auditors and reviewers', async () => {
      expect(await commitment(CALLERS.auditor, request.requestId)).to.include({ recommendation: 'DENY', generationStatus: 'OK' });
      const view = await trail(CALLERS.districtJudge, request.requestId);
      expect(view.recommendationCommitment).to.include({ recommendation: 'DENY' });
      expect(view.summary.recommendation).to.include({ recommendation: 'DENY', generationStatus: 'OK' });
    });

    it('is shown to the requester once the auditor has allowed the request', async () => {
      await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
      expect(await commitment(CALLERS.inspector, request.requestId)).to.include({ recommendation: 'DENY', generationStatus: 'OK' });
      expect((await trail(CALLERS.inspector, request.requestId)).recommendationCommitment).to.include({ recommendation: 'DENY' });
    });

    it('never shows the requester the digest of the auditor note', async () => {
      await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
      const reviewerView = await trail(CALLERS.districtJudge, request.requestId);
      expect(reviewerView.auditorDecision.noteHash).to.match(/^[0-9a-f]{64}$/);
      const requesterView = await trail(CALLERS.inspector, request.requestId);
      expect(requesterView.auditorDecision).to.include({ decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' });
      // The auditor's note is never the requester's to read, and an unsalted digest
      // would let a guessed note be confirmed.
      expect(JSON.stringify(requesterView)).to.not.include(reviewerView.auditorDecision.noteHash);
      expect(requesterView.auditorDecision).to.not.have.property('noteHash');
    });

    it('is shown to the requester once the auditor has decided, in every part of the trail', async () => {
      await world.decide(request.requestId, 'FORCE_DENY', 'DENY');
      expect(await commitment(CALLERS.inspector, request.requestId)).to.include({ recommendation: 'DENY', generationStatus: 'OK' });
      const view = await trail(CALLERS.inspector, request.requestId);
      expect(view.recommendationCommitment).to.include({ recommendation: 'DENY' });
      expect(view.summary.auditor).to.include({ decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED' });
      const committedEvent = view.lifecycle.find((event) => event.eventType === 'RECOMMENDATION_COMMITTED');
      expect(committedEvent.data).to.include({ recommendation: 'DENY', generationStatus: 'OK' });
    });

    // Security review, 2026-10-08: the requester rule comes before reviewer or
    // auditor rights, or an officer holding both could read the recommendation of
    // their own request early and re-request until it says ALLOW.
    for (const [who, own] of [['a court reviewer', CALLERS.judge], ['an audit district head', CALLERS.auditor2]]) {
      it(`is withheld from ${who} for their own request until another auditor has decided`, async () => {
        const { result: mine } = await world.submit(own, { recordId: 'FIR-2' });
        await world.commit(mine.requestId, world.commitmentFor(mine.requestId, { recommendation: 'DENY' }));
        expect(await commitment(own, mine.requestId)).to.include({ withheldUntilDecision: true });
        const before = await trail(own, mine.requestId);
        expect(before).to.include({ viewer: 'reviewer', isRequester: true });
        expect(before.recommendationCommitment).to.include({ withheldUntilDecision: true });
        expect(JSON.stringify(before)).to.not.match(/DENY|generationStatus/);
        // The same officer still reads other requests as a reviewer.
        expect((await trail(own, request.requestId)).recommendationCommitment).to.include({ recommendation: 'DENY' });

        await world.decide(mine.requestId, 'FORCE_DENY', 'DENY');
        const after = await trail(own, mine.requestId);
        expect(after.recommendationCommitment).to.include({ recommendation: 'DENY' });
        expect(after.isRequester).to.equal(true);
      });
    }

    it('keeps an audit district head out of the auditor view of their own request', async () => {
      const { result: mine } = await world.submit(CALLERS.auditor2, { recordId: 'FIR-2' });
      await world.commit(mine.requestId, world.commitmentFor(mine.requestId, { recommendation: 'DENY' }));
      const review = (caller) => read(caller, (ctx) => access().GetAuditorReview(ctx, mine.requestId));
      const queue = (caller) => read(caller, (ctx) => access().QueryPendingAuditorRequests(ctx))
        .then((reviews) => reviews.map((item) => item.request.requestId));
      await expect(review(CALLERS.auditor2)).to.be.rejectedWith(/unauthorized: a district head cannot review their own request/);
      expect(await queue(CALLERS.auditor2)).to.deep.equal([request.requestId]);
      expect(await queue(CALLERS.auditor)).to.have.members([request.requestId, mine.requestId]);
      expect((await review(CALLERS.auditor)).commitment).to.include({ recommendation: 'DENY' });
      // Still refused once it is decided: the auditor view carries the note digest.
      await world.decide(mine.requestId, 'FORCE_DENY', 'ALLOW');
      await expect(review(CALLERS.auditor2)).to.be.rejectedWith(/cannot review their own request/);
    });

    it('stays withheld from the requester when the request ends without a decision', async () => {
      await world.cancel(request.requestId);
      expect(await commitment(CALLERS.inspector, request.requestId)).to.include({ withheldUntilDecision: true });
      expect((await trail(CALLERS.inspector, request.requestId)).recommendationCommitment)
        .to.include({ withheldUntilDecision: true });
    });
  });
});
