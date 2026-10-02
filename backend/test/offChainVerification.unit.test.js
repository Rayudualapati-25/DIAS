'use strict';

/**
 * Audit reconstruction of the off-chain objects (traceability M19; paper §IV-G).
 * The ledger holds a digest of each object the auditor saw or wrote — h_J on the
 * request, h_M in κ, h_N in the decision. A reviewer's request trail reports, for
 * each object, whether the stored copy still hashes to the committed digest.
 */

const { expect } = require('chai');
const { hashText } = require('../../chaincode/crimerecords/lib/dias/commitments');
const { reviewerTrail, verifyOffChainObjects } = require('../src/dias/offChainVerification');
const { commitmentPair, committedRequest } = require('./fixtures/decisionFixtures');

const NOTE = 'The case lead confirmed the assignment by phone.';

/** A decided request as the ledger trail shows it, and the review entry that belongs to it. */
function decidedCase(requestId = 'REQ-1') {
  const pair = commitmentPair(requestId, 'DENY');
  const trail = {
    requestId,
    viewer: 'reviewer',
    request: committedRequest(requestId),
    recommendationCommitment: pair.commitment,
    auditorDecision: { decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED', noteHash: hashText('note', NOTE) },
  };
  const entry = {
    requestId,
    justification: 'Reviewing the FIR.',
    recommendationState: 'committed',
    recommendation: pair.record,
    recommendationObject: pair.recommendationObject,
    auditorNote: { state: 'committed', reason: NOTE, noteHash: hashText('note', NOTE) },
    stagedNotes: [],
  };
  return { trail, entry };
}

const statuses = (verification) => Object.fromEntries(
  Object.entries(verification).map(([name, result]) => [name, result.status])
);

describe('off-chain objects checked against their ledger digests', () => {
  it('verifies the justification, the recommendation object and the note', () => {
    const { trail, entry } = decidedCase();
    const verification = verifyOffChainObjects({ trail, entry });
    expect(statuses(verification)).to.deep.equal({
      justification: 'verified', recommendation: 'verified', note: 'verified',
    });
    expect(verification.note.committed).to.equal(hashText('note', NOTE));
  });

  it('reports each object changed after its digest was committed', () => {
    const { trail, entry } = decidedCase();
    const changed = {
      ...entry,
      justification: 'Reviewing the FIR. (edited)',
      recommendationObject: {
        ...entry.recommendationObject,
        output: { ...entry.recommendationObject.output, reason: 'a different explanation' },
      },
      auditorNote: { ...entry.auditorNote, reason: `${NOTE} (edited)` },
    };
    const verification = verifyOffChainObjects({ trail, entry: changed });
    expect(statuses(verification)).to.deep.equal({
      justification: 'mismatch', recommendation: 'mismatch', note: 'mismatch',
    });
    expect(verification.recommendation.problems.join(' ')).to.match(/h_M/);
  });

  it('reports objects whose digest is committed but whose copy is gone', () => {
    const { trail } = decidedCase();
    expect(statuses(verifyOffChainObjects({ trail, entry: null }))).to.deep.equal({
      justification: 'missing', recommendation: 'missing', note: 'missing',
    });
  });

  it('finds a committed note that is still only staged', () => {
    const { trail, entry } = decidedCase();
    const staged = {
      ...entry,
      auditorNote: null,
      stagedNotes: [{ noteHash: hashText('note', NOTE), reason: NOTE, decision: 'FORCE_ALLOW' }],
    };
    expect(verifyOffChainObjects({ trail, entry: staged }).note.status).to.equal('verified');
  });

  it('says when no digest was committed at all', () => {
    const { trail, entry } = decidedCase();
    const bare = {
      ...trail,
      request: { ...trail.request, justificationHash: undefined },
      recommendationCommitment: null,
      auditorDecision: { decision: 'FORCE_DENY', llmAgreement: 'AGREED', noteHash: null },
    };
    expect(statuses(verifyOffChainObjects({ trail: bare, entry }))).to.deep.equal({
      justification: 'not-committed', recommendation: 'not-committed', note: 'not-committed',
    });
  });

  it('adds the off-chain review and its verification to a reviewer trail only', () => {
    const { trail, entry } = decidedCase();
    const view = reviewerTrail({ trail, entry });
    expect(view.offChainReview).to.include({ justification: 'Reviewing the FIR.' });
    expect(view.offChainReview.auditorNote).to.include({ reason: NOTE });
    expect(statuses(view.offChainVerification)).to.deep.equal({
      justification: 'verified', recommendation: 'verified', note: 'verified',
    });
    const requesterView = reviewerTrail({ trail: { ...trail, viewer: 'requester' }, entry });
    expect(requesterView).to.not.have.any.keys('offChainReview', 'offChainVerification');
  });
});
