'use strict';

/**
 * Who may read the LLM's account of a recommendation (design §10, step 13).
 *
 * An audit-organisation district head reads it at any time. The officer who made
 * the request reads it according to the auditor's decision (author's rule,
 * 2026-10-08): nothing before a decision; the explanation and the decision when
 * the request was denied; the decision and the recommendation value, without the
 * explanation, when it was allowed. Nobody else reads it. District-head roles
 * exist in every organisation, so the organisation is checked as well as the role.
 */

const { expect } = require('chai');

const {
  WITHHELD, explanationFor, recommendationDetail,
} = require('../src/dias/recommendationDetail');
const { AUDITOR_ROLES } = require('../src/routes/access');

const REQUEST_ID = 'REQ-1';

const entryWith = (recommendation, state = 'ready') => ({
  requestId: REQUEST_ID,
  requesterUsername: 'insp.test',
  recommendationState: state,
  recommendation,
});

const produced = () => ({
  generationStatus: 'OK',
  recommendation: 'DENY',
  reasonCode: 'NOT_ASSIGNED',
  reason: 'The officer is not assigned to CASE-1 and the record is sealed.',
  policyRefs: ['GP-ASSIGN:C1@v1'],
  missingEvidence: ['case assignment'],
  reviewFlags: ['SEALED_RECORD_COURT_REVIEW'],
  errorCode: null,
  provenance: {
    modelId: 'dias-v7', adapterHash: 'abc', policyBundleVersion: 'v1',
    latencyMs: { total: 812 }, usage: { promptTokens: 2200, completionTokens: 90 },
  },
});

const detailFor = (entry, reasonVisible) =>
  recommendationDetail(entry, { requestId: REQUEST_ID, reasonVisible });

const REQUESTER = Object.freeze({ org: 'police', fabricUser: 'insp.test', role: 'inspector' });
const AUDITOR = Object.freeze({ org: 'audit', fabricUser: 'sp.north', role: 'sp' });
const DECIDED_AT = '2026-10-08T09:00:00.000Z';

/** The ledger's request trail, as the chaincode returns it to this kind of viewer. */
function trailWith({
  viewer = 'requester', decision = null, llmRecommendation = 'DENY', llmAgreement = 'AGREED',
  outcome = null, basis = 'AUDITOR_DECISION',
} = {}) {
  return {
    requestId: REQUEST_ID,
    viewer,
    summary: {
      requestId: REQUEST_ID,
      auditor: decision
        ? { username: 'sp.north', role: 'sp', decision, llmRecommendation, llmAgreement, txId: 'tx-1' }
        : { status: 'PENDING' },
      outcome: outcome ? { outcome, basis, txId: 'tx-2' } : null,
    },
    auditorDecision: decision ? { decision, decidedAtUtc: DECIDED_AT, noteHash: 'f'.repeat(64) } : null,
  };
}

const denied = (overrides = {}) => trailWith({ decision: 'FORCE_DENY', outcome: 'DENIED', ...overrides });
const allowed = (overrides = {}) => trailWith({
  decision: 'FORCE_ALLOW', outcome: 'GRANTED', llmRecommendation: 'ALLOW', ...overrides,
});
const ask = (user, trail, entry = entryWith(produced())) => explanationFor({
  user, trail, entry, auditorRoles: AUDITOR_ROLES,
});
/** Every field of the model's account, empty. */
const NOTHING = Object.freeze({
  recommendationState: 'withheld', available: false, recommendation: null, reasonCode: null,
  policyRefs: [], missingEvidence: [], reviewFlags: [], unavailable: null, reason: null, reasonVisible: false,
});

describe('LLM explanation of a request', () => {
  describe('for the officer who made the request', () => {
    it('shows nothing from the LLM before an auditor has decided', () => {
      for (const entry of [entryWith(produced()), entryWith(null, 'pending'), null]) {
        expect(ask(REQUESTER, trailWith(), entry)).to.deep.equal({
          status: 200,
          data: {
            requestId: REQUEST_ID, viewer: 'requester', decision: null, outcome: null,
            explanationVisible: false, withheld: WITHHELD.AWAITING_DECISION, ...NOTHING,
          },
        });
      }
    });

    it('shows the decision and the LLM explanation when the auditor denied the request', () => {
      const { status, data } = ask(REQUESTER, denied());
      expect(status).to.equal(200);
      expect(data).to.include({
        viewer: 'requester', explanationVisible: true, withheld: null, recommendationState: 'ready',
        available: true, recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED',
        reason: produced().reason, reasonVisible: true,
      });
      expect(data.policyRefs).to.deep.equal(['GP-ASSIGN:C1@v1']);
      expect(data.decision).to.deep.equal({
        decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED',
        auditor: { username: 'sp.north', role: 'sp' }, decidedAtUtc: DECIDED_AT,
      });
      expect(data.outcome).to.deep.equal({ outcome: 'DENIED', basis: 'AUDITOR_DECISION' });
    });

    it('shows the explanation as the LLM gave it when the auditor denied against an LLM ALLOW', () => {
      const entry = entryWith({ ...produced(), recommendation: 'ALLOW', reasonCode: 'POLICY_SATISFIED' });
      const { data } = ask(REQUESTER, denied({ llmRecommendation: 'ALLOW', llmAgreement: 'NOT_AGREED' }), entry);
      expect(data).to.include({ explanationVisible: true, recommendation: 'ALLOW', reasonVisible: true });
      expect(data.decision).to.include({ decision: 'FORCE_DENY', llmAgreement: 'NOT_AGREED' });
    });

    it('says there was no LLM recommendation when the auditor denied without one', () => {
      const failed = entryWith({
        generationStatus: 'UNAVAILABLE', recommendation: null, reasonCode: null, reason: null,
        policyRefs: [], missingEvidence: [], reviewFlags: [], errorCode: 'server_unreachable', provenance: {},
      });
      const { data } = ask(REQUESTER, denied({ llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION' }), failed);
      expect(data).to.include({ explanationVisible: true, available: false, recommendation: null, reason: null });
      expect(data.unavailable).to.deep.equal({ generationStatus: 'UNAVAILABLE', errorCode: 'server_unreachable' });
    });

    it('shows the decision and the recommendation value, without the explanation, when allowed', () => {
      for (const llmRecommendation of ['ALLOW', 'DENY']) {
        const trail = allowed({ llmRecommendation, llmAgreement: llmRecommendation === 'ALLOW' ? 'AGREED' : 'NOT_AGREED' });
        expect(ask(REQUESTER, trail).data).to.deep.equal({
          requestId: REQUEST_ID,
          viewer: 'requester',
          decision: {
            decision: 'FORCE_ALLOW', llmRecommendation, llmAgreement: trail.summary.auditor.llmAgreement,
            auditor: { username: 'sp.north', role: 'sp' }, decidedAtUtc: DECIDED_AT,
          },
          outcome: { outcome: 'GRANTED', basis: 'AUDITOR_DECISION' },
          explanationVisible: false,
          withheld: WITHHELD.ALLOWED,
          ...NOTHING,
          recommendation: llmRecommendation,
        });
      }
    });

    it('shows nothing from the LLM when no auditor decided: a reused authorization, an expiry, a cancellation', () => {
      for (const [outcome, basis] of [
        ['GRANTED', 'DYNAMIC_AUTHORIZATION'], ['EXPIRED', 'REVIEW_DEADLINE'], ['CANCELLED', 'REQUESTER_CANCELLED'],
      ]) {
        expect(ask(REQUESTER, trailWith({ outcome, basis })).data, basis).to.deep.equal({
          requestId: REQUEST_ID, viewer: 'requester', decision: null, outcome: { outcome, basis },
          explanationVisible: false, withheld: WITHHELD.NO_AUDITOR_DECISION, ...NOTHING,
        });
      }
    });

    it('never returns the auditor note, timings, token counts or model and policy provenance', () => {
      for (const trail of [trailWith(), denied(), allowed()]) {
        expect(JSON.stringify(ask(REQUESTER, trail))).to.not.match(
          /noteHash|latency|promptTokens|completionTokens|modelId|adapterHash|policyBundle|promptHash|provenance/i
        );
      }
    });
  });

  describe('for everyone else', () => {
    it('gives an audit-organisation district head the full account at every stage', () => {
      const reviewer = { viewer: 'reviewer' };
      for (const trail of [trailWith(reviewer), denied(reviewer), allowed(reviewer)]) {
        const { status, data } = ask(AUDITOR, trail);
        expect(status).to.equal(200);
        expect(data).to.include({
          viewer: 'auditor', explanationVisible: true, withheld: null, recommendation: 'DENY',
          reason: produced().reason, reasonVisible: true,
        });
      }
      expect(ask(AUDITOR, trailWith(reviewer)).data.decision).to.equal(null);
      expect(ask(AUDITOR, denied(reviewer)).data.decision).to.include({ decision: 'FORCE_DENY' });
    });

    it('refuses a reviewer of another organisation, whose role name may be the same', () => {
      for (const user of [
        { org: 'court', fabricUser: 'dj.north', role: 'district-judge' },
        { org: 'prosecution', fabricUser: 'dp.north', role: 'director-of-prosecution' },
        { org: 'court', fabricUser: 'judge.rana', role: 'judge' },
        { org: 'police', fabricUser: 'sp.city', role: 'sp' },
      ]) {
        expect(ask(user, denied({ viewer: 'reviewer' })), user.fabricUser).to.deep.equal({
          status: 403,
          error: 'only the officer who made the request and an audit-organisation district head '
            + 'may read the LLM detail of a request',
        });
      }
    });

    // Security review, 2026-10-08: an officer who is also a reviewer or an auditor
    // is still the requester of their own request. The ledger trail says so.
    it('treats an audit district head as the requester of their own request', () => {
      const own = { viewer: 'reviewer', isRequester: true };
      const waiting = ask(AUDITOR, { ...trailWith(own), isRequester: true });
      expect(waiting.data).to.include({ viewer: 'requester', withheld: WITHHELD.AWAITING_DECISION, recommendation: null, reason: null });
      const after = ask(AUDITOR, { ...allowed(own), isRequester: true });
      expect(after.data).to.include({ viewer: 'requester', explanationVisible: false, withheld: WITHHELD.ALLOWED, reason: null });
    });

    it('gives a court reviewer the explanation of their own denied request, as any requester', () => {
      const judge = { org: 'court', fabricUser: 'judge.rana', role: 'judge' };
      const own = { ...denied({ viewer: 'reviewer' }), isRequester: true };
      const { status, data } = ask(judge, own);
      expect(status).to.equal(200);
      expect(data).to.include({ viewer: 'requester', explanationVisible: true, reason: produced().reason });
      // For somebody else's request the same judge is still refused.
      expect(ask(judge, denied({ viewer: 'reviewer' })).status).to.equal(403);
    });

    it('refuses a missing user or a trail the ledger did not return', () => {
      expect(ask(null, denied()).status).to.equal(403);
      expect(ask(REQUESTER, null).status).to.equal(403);
    });
  });

  describe('the model\'s account itself', () => {
    it('has a structured part, and withholds the free text unless it is to be shown', () => {
      const detail = detailFor(entryWith(produced()), false);
      expect(detail).to.deep.equal({
        requestId: REQUEST_ID,
        recommendationState: 'ready',
        available: true,
        recommendation: 'DENY',
        reasonCode: 'NOT_ASSIGNED',
        policyRefs: ['GP-ASSIGN:C1@v1'],
        missingEvidence: ['case assignment'],
        reviewFlags: ['SEALED_RECORD_COURT_REVIEW'],
        unavailable: null,
        reason: null,
        reasonVisible: false,
      });
    });

    it('adds the free text for a caller who may read it', () => {
      const detail = detailFor(entryWith(produced()), true);
      expect(detail.reasonVisible).to.equal(true);
      expect(detail.reason).to.equal(produced().reason);
    });

    it('never returns timings, token counts or model and policy provenance', () => {
      for (const visible of [true, false]) {
        const text = JSON.stringify(detailFor(entryWith(produced()), visible));
        expect(text).to.not.match(
          /latency|promptTokens|completionTokens|modelId|adapterHash|policyBundle|promptHash|provenance/i
        );
      }
    });

    it('says why there was no recommendation, and offers nothing to read', () => {
      const failed = entryWith({
        generationStatus: 'UNAVAILABLE', recommendation: null, reasonCode: null, reason: null,
        policyRefs: [], missingEvidence: [], reviewFlags: [], errorCode: 'server_unreachable',
        provenance: {},
      });
      const detail = detailFor(failed, true);
      expect(detail.available).to.equal(false);
      expect(detail.recommendation).to.equal(null);
      expect(detail.reason).to.equal(null);
      expect(detail.unavailable).to.deep.equal({
        generationStatus: 'UNAVAILABLE', errorCode: 'server_unreachable',
      });
    });

    it('reports a recommendation still being prepared', () => {
      const detail = detailFor(entryWith(null, 'pending'), true);
      expect(detail).to.include({ recommendationState: 'pending', available: false });
      expect(detail.unavailable).to.equal(null);
    });

    it('reports a request whose review was never stored', () => {
      const detail = detailFor(null, true);
      expect(detail).to.include({ recommendationState: 'not-generated', available: false });
      expect(detail.unavailable).to.deep.equal({
        generationStatus: 'NOT_GENERATED', errorCode: 'no_review_stored',
      });
    });
  });
});
