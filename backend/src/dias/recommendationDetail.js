'use strict';

/**
 * The LLM's account of one recommendation, and who may read it (design §10).
 *
 * The account has a structured part — reason code, the policy clauses cited, what
 * the model said was missing, the review flags it raised, and why there was no
 * recommendation at all — and a free-text reason, which is case narrative and can
 * quote a sealed, juvenile or victim-protected detail.
 *
 *   - An audit-organisation district head reads all of it, at any time.
 *   - The officer who made the request reads it according to the auditor's
 *     decision (author's rule, 2026-10-08): nothing before a decision; the
 *     decision and the whole account when the request was denied; the decision
 *     and the recommendation value, without the account, when it was allowed.
 *   - Nobody else reads any of it.
 *
 * Nothing about how the recommendation was produced appears here: no latency, no
 * token counts, no model identity and no policy bundle hashes. Those stay in the
 * off-chain review entry for an auditor who goes looking for them. The auditor's
 * note is never part of this view.
 */

const AUDIT_ORG = 'audit';

/** Why the model's account is not shown to the officer who made the request. */
const WITHHELD = Object.freeze({
  AWAITING_DECISION: 'awaiting-decision',
  ALLOWED: 'allowed',
  NO_AUDITOR_DECISION: 'no-auditor-decision',
});

/**
 * Whether this caller is an audit-organisation district head. The organisation
 * is checked as well as the role because district-head roles exist in every
 * organisation, and only the audit organisation reviews requests.
 */
const isAuditor = (user, auditorRoles) => Boolean(user)
  && user.org === AUDIT_ORG && auditorRoles.includes(user.role);

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

/** Every field of the account, empty: what a caller gets when it is withheld. */
function withheldDetail(requestId) {
  return { ...absentDetail(requestId), recommendationState: 'withheld', unavailable: null };
}

/** The auditor's decision as the ledger trail records it, or null before one exists. */
function decisionOf(trail) {
  const auditor = trail.summary && trail.summary.auditor;
  if (!auditor || !auditor.decision) return null;
  return {
    decision: auditor.decision,
    llmRecommendation: auditor.llmRecommendation,
    llmAgreement: auditor.llmAgreement,
    auditor: { username: auditor.username, role: auditor.role },
    decidedAtUtc: (trail.auditorDecision && trail.auditorDecision.decidedAtUtc) || null,
  };
}

/** What the officer who made the request may read, given what the auditor decided. */
function requesterView({ requestId, entry, decision, outcome }) {
  const base = { requestId, viewer: 'requester', decision, outcome };
  if (!decision) {
    const withheld = outcome ? WITHHELD.NO_AUDITOR_DECISION : WITHHELD.AWAITING_DECISION;
    return { ...base, explanationVisible: false, withheld, ...withheldDetail(requestId) };
  }
  if (decision.decision === 'FORCE_DENY') {
    return {
      ...base, explanationVisible: true, withheld: null,
      ...recommendationDetail(entry, { requestId, reasonVisible: true }),
    };
  }
  // Allowed: the decision and the recommendation value the ledger already shows.
  const recommended = ['ALLOW', 'DENY'].includes(decision.llmRecommendation) ? decision.llmRecommendation : null;
  return {
    ...base, explanationVisible: false, withheld: WITHHELD.ALLOWED,
    ...withheldDetail(requestId), recommendation: recommended,
  };
}

/**
 * The LLM detail of one request for this caller.
 *
 * `trail` is the ledger's request audit trail read as the caller: the contract
 * returns it only to a reviewer or to the requester, and says which.
 *
 * @returns {{status: 200, data: object} | {status: 403, error: string}}
 */
function explanationFor({ user, trail, entry, auditorRoles }) {
  // Whoever made the request is its requester first, also when they hold a
  // reviewer or auditor role themselves; the ledger trail says so.
  const requester = Boolean(trail) && (trail.isRequester === true || trail.viewer === 'requester');
  const auditor = !requester && isAuditor(user, auditorRoles);
  if (!user || !trail || (!auditor && !requester)) {
    return {
      status: 403,
      error: 'only the officer who made the request and an audit-organisation district head '
        + 'may read the LLM detail of a request',
    };
  }
  const { requestId } = trail;
  const decision = decisionOf(trail);
  const settled = trail.summary && trail.summary.outcome;
  const outcome = settled ? { outcome: settled.outcome, basis: settled.basis } : null;
  if (requester) return { status: 200, data: requesterView({ requestId, entry, decision, outcome }) };
  return {
    status: 200,
    data: {
      requestId, viewer: 'auditor', decision, outcome, explanationVisible: true, withheld: null,
      ...recommendationDetail(entry, { requestId, reasonVisible: true }),
    },
  };
}

module.exports = {
  AUDIT_ORG, WITHHELD, explanationFor, isAuditor, recommendationDetail,
};
