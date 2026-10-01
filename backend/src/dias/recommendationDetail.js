'use strict';

/**
 * The LLM detail behind one decision, as the decision log's "why" view shows it.
 *
 * The log line itself is public: who asked, what the auditor decided, and the
 * recommendation value committed on the ledger. This adds the model's own
 * account of that recommendation, and it is split in two:
 *
 *   - the structured part — reason code, the policy clauses cited, what the
 *     model said was missing, the review flags it raised, and why there was no
 *     recommendation at all — which every signed-in identity may read;
 *   - the free-text reason, which is case narrative and can quote a sealed,
 *     juvenile or victim-protected detail, so only the officer who made the
 *     request and an audit-organisation district head may read it.
 *
 * Nothing about how the recommendation was produced appears here: no latency, no
 * token counts, no model identity and no policy bundle hashes. Those stay in the
 * off-chain review entry for a reviewer who goes looking for them.
 */

const AUDIT_ORG = 'audit';

/**
 * Whether this caller may read the model's free text for this entry.
 *
 * The organisation is checked as well as the role because district-head roles
 * exist in every organisation, and only the audit organisation reviews requests.
 */
function mayReadReasonText(user, entry, auditorRoles) {
  if (!user || !entry) return false;
  const isRequester = Boolean(user.fabricUser) && user.fabricUser === entry.requesterUsername;
  const isAuditor = user.org === AUDIT_ORG && auditorRoles.includes(user.role);
  return isRequester || isAuditor;
}

const list = (value) => (Array.isArray(value) ? value : []);

/** The detail for a request whose review the backend never stored. */
function absentDetail(requestId) {
  return {
    requestId,
    recommendationState: 'not-generated',
    available: false,
    recommendation: null,
    reasonCode: null,
    policyRefs: [],
    missingEvidence: [],
    reviewFlags: [],
    unavailable: {
      generationStatus: 'NOT_GENERATED',
      errorCode: 'no_review_stored',
    },
    reason: null,
    reasonVisible: false,
  };
}

/**
 * Shape one stored review entry for the detail view.
 *
 * @param {object|null} entry the off-chain review entry, or null if there is none
 * @param {object} options
 * @param {string} options.requestId the request this detail belongs to
 * @param {boolean} options.reasonVisible whether this caller may read the free text
 */
function recommendationDetail(entry, { requestId, reasonVisible }) {
  if (!entry) return absentDetail(requestId);
  if (entry.recommendationState === 'pending') {
    return { ...absentDetail(requestId), recommendationState: 'pending', unavailable: null };
  }
  const recommendation = entry.recommendation || null;
  if (!recommendation) return absentDetail(requestId);
  const produced = recommendation.generationStatus === 'OK'
    && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
  return {
    requestId,
    recommendationState: 'ready',
    available: produced,
    recommendation: produced ? recommendation.recommendation : null,
    reasonCode: produced ? recommendation.reasonCode : null,
    policyRefs: produced ? list(recommendation.policyRefs) : [],
    missingEvidence: produced ? list(recommendation.missingEvidence) : [],
    reviewFlags: produced ? list(recommendation.reviewFlags) : [],
    unavailable: produced ? null : {
      generationStatus: recommendation.generationStatus,
      errorCode: recommendation.errorCode || null,
    },
    reason: produced && reasonVisible ? (recommendation.reason || null) : null,
    reasonVisible: Boolean(reasonVisible),
  };
}

module.exports = { AUDIT_ORG, mayReadReasonText, recommendationDetail };
