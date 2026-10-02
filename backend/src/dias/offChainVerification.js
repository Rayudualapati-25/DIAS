'use strict';

/**
 * Audit reconstruction of the off-chain objects (design §3, §4; paper §IV-G).
 *
 * The ledger commits a digest of each object the auditor saw or wrote: the
 * justification (h_J on the request), the recommendation object M (h_M in κ) and
 * the auditor note (h_N in the decision). The objects themselves stay in the
 * review store. For each one this reports:
 *
 *   verified       the stored copy hashes to the committed digest;
 *   mismatch       it does not: the copy was changed after the digest was committed;
 *   missing        a digest is committed, but no copy is available;
 *   not-committed  the ledger holds no digest (no κ, no note, or an older record).
 *
 * A digest proves what the object was when it was committed. It cannot bring
 * back a lost object.
 */

const { DOMAINS, hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');
const { checkRecommendationIntegrity } = require('./recommendationIntegrity');

function checkText(domain, committed, text) {
  if (!committed) return { status: 'not-committed', committed: null, computed: null };
  if (typeof text !== 'string') return { status: 'missing', committed, computed: null };
  let computed = null;
  try {
    computed = hashText(domain, text);
  } catch (_error) {
    return { status: 'mismatch', committed, computed: null };
  }
  return { status: computed === committed ? 'verified' : 'mismatch', committed, computed };
}

function checkRecommendation(commitment, recommendationObject) {
  if (!commitment) return { status: 'not-committed', committed: null, computed: null, problems: [] };
  const integrity = checkRecommendationIntegrity({ commitment, recommendationObject });
  return {
    status: integrity.status === 'missing-object' ? 'missing' : integrity.status,
    committed: commitment.recommendationHash,
    computed: integrity.recommendationHash,
    problems: integrity.problems,
  };
}

/** The note text whose digest the decision committed: the committed copy, or a staged one. */
function noteTextFor(entry, noteHash) {
  if (!entry) return null;
  if (entry.auditorNote && typeof entry.auditorNote.reason === 'string') return entry.auditorNote.reason;
  const staged = (entry.stagedNotes || []).find((note) => note.noteHash === noteHash);
  return staged ? staged.reason : null;
}

function verifyOffChainObjects({ trail, entry }) {
  const request = trail.request || {};
  const decision = trail.auditorDecision || {};
  return {
    justification: checkText(DOMAINS.JUSTIFICATION, request.justificationHash, entry ? entry.justification : null),
    recommendation: checkRecommendation(trail.recommendationCommitment || null,
      entry ? entry.recommendationObject : null),
    note: checkText(DOMAINS.NOTE, decision.noteHash, noteTextFor(entry, decision.noteHash)),
  };
}

/**
 * The request trail a reviewer receives: the ledger's trail, the off-chain review
 * clearly marked as such, and the verification of each off-chain object. Any
 * other viewer receives the ledger's trail unchanged.
 */
function reviewerTrail({ trail, entry }) {
  if (trail.viewer !== 'reviewer') return trail;
  return {
    ...trail,
    offChainReview: entry ? {
      storage: 'backend off-chain review store (not on the ledger)',
      justification: entry.justification,
      recommendationState: entry.recommendationState,
      recommendation: entry.recommendation,
      auditorNote: entry.auditorNote,
    } : null,
    offChainVerification: verifyOffChainObjects({ trail, entry }),
  };
}

module.exports = { reviewerTrail, verifyOffChainObjects };
