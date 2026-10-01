'use strict';

/**
 * The decision log's "why" view.
 *
 * Two properties matter here. The structured account of a recommendation is
 * readable by every signed-in identity, and the model's free text is readable
 * only by the officer who made the request and by an audit-organisation
 * district head. District-head roles exist in every organisation, so the
 * organisation has to be checked as well as the role.
 */

const { expect } = require('chai');

const {
  mayReadReasonText, recommendationDetail,
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

describe('decision log recommendation detail', () => {
  describe('who may read the model free text', () => {
    const entry = entryWith(produced());

    it('lets the officer who made the request read it', () => {
      expect(mayReadReasonText(
        { org: 'police', fabricUser: 'insp.test', role: 'inspector' }, entry, AUDITOR_ROLES
      )).to.equal(true);
    });

    it('lets an audit-organisation district head read it', () => {
      expect(mayReadReasonText(
        { org: 'audit', fabricUser: 'sp.north', role: 'sp' }, entry, AUDITOR_ROLES
      )).to.equal(true);
    });

    it('refuses a district head of any other organisation', () => {
      for (const user of [
        { org: 'police', fabricUser: 'sp.city', role: 'sp' },
        { org: 'court', fabricUser: 'dj.north', role: 'district-judge' },
        { org: 'forensics', fabricUser: 'cfo.lab', role: 'chief-forensic-officer' },
        { org: 'prosecution', fabricUser: 'dp.north', role: 'director-of-prosecution' },
      ]) {
        expect(mayReadReasonText(user, entry, AUDITOR_ROLES), user.org).to.equal(false);
      }
    });

    it('refuses any other signed-in identity, and a missing user or entry', () => {
      expect(mayReadReasonText(
        { org: 'police', fabricUser: 'con.test', role: 'constable' }, entry, AUDITOR_ROLES
      )).to.equal(false);
      expect(mayReadReasonText(null, entry, AUDITOR_ROLES)).to.equal(false);
      expect(mayReadReasonText({ org: 'audit', role: 'sp' }, null, AUDITOR_ROLES)).to.equal(false);
    });
  });

  describe('what the view returns', () => {
    it('gives everyone the structured account and withholds the free text', () => {
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
