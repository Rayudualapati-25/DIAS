/**
 * Pure DIAS view-model helpers shared by the requester and auditor screens.
 *
 * The vocabulary here is deliberately strict about one thing: a recommendation
 * is not a decision. `recommendationView` never produces an outcome, and
 * `outcomeView` never reads the model's answer. Keeping the two apart in the
 * view model is what stops a screen from showing "DENY" as though access had
 * been refused when no auditor has looked at it yet.
 *
 * The model runs behind the recommendation service. The complete recommendation
 * object stays off-chain; before review its digest h_M, value, generation status
 * and request bindings are committed on the ledger (κ). Agreement is computed by
 * the contract against κ, never against what the backend reports (paper Eq. 3),
 * and these helpers recompute the digests so a screen can show a mismatch.
 */

import { hashCanonical, hashText, isDigest } from './commitments.js';

const BOUND_FIELDS = Object.freeze([
  'contextHash', 'claimsHash', 'justificationHash', 'policyVersion', 'policyHash', 'modelVersion',
]);

/**
 * Is the recommendation object shown to the auditor the one committed on the
 * ledger before review (κ)? Recomputed here, independently of the backend:
 * h_M, the value, the status, the request and every binding (paper §IV-D).
 */
export function recommendationIntegrity(review) {
  const commitment = review?.commitment || null;
  const object = review?.recommendationObject || null;
  if (!commitment) return { status: 'no-commitment', problems: [] };
  if (!object) return { status: 'missing-object', problems: ['the committed recommendation object is not available'] };
  const problems = [];
  let computed = null;
  try {
    computed = hashCanonical('recommendation', object);
  } catch {
    problems.push('the displayed object cannot be put in canonical form');
  }
  if (computed !== commitment.recommendationHash) {
    problems.push('h_M of the displayed object differs from the committed recommendationHash');
  }
  if (object.recommendation !== commitment.recommendation) problems.push('recommendation differs from the commitment');
  if (object.generationStatus !== commitment.generationStatus) problems.push('generation status differs from the commitment');
  if (object.requestId !== commitment.requestId) problems.push('request differs from the commitment');
  for (const field of BOUND_FIELDS) {
    if ((object.provenance || {})[field] !== commitment[field]) problems.push(`${field} differs from the commitment`);
  }
  return { status: problems.length === 0 ? 'verified' : 'mismatch', problems, computed };
}

/**
 * The recommendation a decision is compared with: the committed κ when there
 * is one (with the explanation text of the verified object), otherwise the
 * stored failure record, otherwise none.
 */
export function committedRecommendation(review) {
  const commitment = review?.commitment;
  if (commitment) {
    return {
      ...(review.recommendation || {}),
      generationStatus: commitment.generationStatus,
      recommendation: commitment.recommendation,
    };
  }
  return review?.recommendation || null;
}

/**
 * Does the justification digest the ledger committed (h_J) belong to the text
 * this requester sent? Recomputed in the browser, so a backend that altered the
 * text before hashing it is caught by the requester (design §4).
 */
export function justificationCommitmentView(sentText, request) {
  const committed = request?.justificationHash;
  if (!isDigest(committed)) return { status: 'absent', committed: null, computed: null };
  const computed = hashText('justification', sentText);
  return { status: computed === committed ? 'match' : 'mismatch', committed, computed };
}

/** The request statuses the chaincode can commit. */
export const STATUS = Object.freeze({
  AWAITING_AUDITOR: 'awaiting-auditor',
  GRANTED: 'granted',
  DENIED: 'denied',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

/** Whether the auditor decision agreed with the LLM, as committed on the ledger. */
export const LLM_AGREEMENT = Object.freeze({
  AGREED: 'AGREED',
  NOT_AGREED: 'NOT_AGREED',
  NO_RECOMMENDATION: 'NO_RECOMMENDATION',
});

const FINAL = Object.freeze([STATUS.GRANTED, STATUS.DENIED, STATUS.EXPIRED, STATUS.CANCELLED]);

export function isSettled(request) {
  return FINAL.includes(request?.status);
}

/** True only for a grant that an active dynamic authorization produced by itself. */
export function isAutomaticGrant(request) {
  return request?.status === STATUS.GRANTED
    && request?.processingPath === 'dynamic-authorization';
}

export function progressLabel(request) {
  if (isAutomaticGrant(request)) return 'granted automatically by dynamic authorization';
  if (request?.status === STATUS.GRANTED) return 'granted by auditor';
  if (request?.status === STATUS.DENIED) return 'denied by auditor';
  if (request?.status === STATUS.EXPIRED) return 'expired before an auditor decided';
  if (request?.status === STATUS.CANCELLED) return 'cancelled by the requester';
  return 'waiting for auditor';
}

/** Who actually decided. Never the model. */
export function decisionAuthorityLabel(request) {
  if (isAutomaticGrant(request)) return 'Active dynamic authorization';
  if (request?.status === STATUS.EXPIRED) return 'Nobody: the review deadline passed';
  if (request?.status === STATUS.CANCELLED) return 'Nobody: the requester cancelled';
  if (isSettled(request)) return 'AuditMSP auditor';
  return 'Not yet decided';
}

const OUTCOME_LABEL = Object.freeze({
  granted: 'GRANTED', denied: 'DENIED', expired: 'EXPIRED', cancelled: 'CANCELLED',
});
const AUTHORITY_LABEL = Object.freeze({
  'dynamic-authorization': 'Active dynamic authorization',
  auditor: 'AuditMSP auditor',
  'review-deadline': 'Review deadline',
  'policy-change': 'Policy version change',
  requester: 'Requester',
});

/**
 * A committed access decision, as its requester sees it: the outcome and who
 * decided it — an auditor or an active dynamic authorization. It carries no
 * model output; the LLM recommendation belongs to the auditor's review.
 */
export function accessDecisionView(decision) {
  const granted = decision?.status === STATUS.GRANTED;
  const automatic = decision?.decisionAuthority === 'dynamic-authorization';
  return {
    decisionId: decision?.decisionId || null,
    requestId: decision?.requestId || null,
    recordId: decision?.recordId || null,
    outcomeLabel: OUTCOME_LABEL[decision?.status] || 'DENIED',
    granted,
    automatic,
    authorityLabel: AUTHORITY_LABEL[decision?.decisionAuthority] || 'AuditMSP auditor',
    auditorDecisionId: decision?.auditorDecisionId || null,
    authorizationId: decision?.authorizationId || null,
    action: decision?.action || null,
    purpose: decision?.purpose || null,
    recordedAtUtc: decision?.createdAtUtc || null,
    // Only a granted view opens case-file metadata and the full-document request.
    releasesMetadata: granted && decision?.action === 'view',
  };
}

/**
 * The model's advisory answer, or an explicit statement that none exists.
 * `state` is the backend's preparation state: 'pending' while the LLM is still
 * working, 'ready' once a result (or a failure) is stored, and 'not-generated'
 * when the backend never prepared one. The auditor still decides in every case.
 */
export function recommendationView(recommendation, state = recommendation ? 'ready' : 'not-generated') {
  if (state === 'pending') {
    return { available: false, pending: true, status: 'PENDING', label: 'being prepared', advisory: true };
  }
  if (!recommendation) {
    return { available: false, status: 'NOT_GENERATED', label: 'no recommendation', advisory: true };
  }
  if (recommendation.generationStatus !== 'OK') {
    return {
      available: false,
      status: recommendation.generationStatus,
      label: `no recommendation (${recommendation.generationStatus})`,
      errorCode: recommendation.errorCode || null,
      advisory: true,
    };
  }
  return {
    available: true,
    status: 'OK',
    recommendation: recommendation.recommendation,
    label: recommendation.recommendation,
    reasonCode: recommendation.reasonCode,
    reason: recommendation.reason || null,
    policyRefs: recommendation.policyRefs || [],
    missingEvidence: recommendation.missingEvidence || [],
    reviewFlags: recommendation.reviewFlags || [],
    advisory: true,
  };
}

/** What the ledger will record about agreement if the auditor makes this decision. */
export function llmAgreement(recommendation, decision) {
  const view = recommendationView(recommendation);
  if (!view.available) return LLM_AGREEMENT.NO_RECOMMENDATION;
  const auditorAllows = decision === 'FORCE_ALLOW';
  return (view.recommendation === 'ALLOW') === auditorAllows
    ? LLM_AGREEMENT.AGREED : LLM_AGREEMENT.NOT_AGREED;
}

/** How the ledger's committed recommendation value reads in the decision log. */
export function recommendationLabel(value) {
  if (value === 'ALLOW') return 'the LLM recommended ALLOW';
  if (value === 'DENY') return 'the LLM recommended DENY';
  if (value === 'UNAVAILABLE') return 'no LLM recommendation was available';
  return 'the LLM was not consulted';
}

export function agreementLabel(value) {
  if (value === LLM_AGREEMENT.AGREED) return 'agreed with the LLM';
  if (value === LLM_AGREEMENT.NOT_AGREED) return 'did not agree with the LLM';
  if (value === LLM_AGREEMENT.NO_RECOMMENDATION) return 'no LLM recommendation';
  return 'not yet decided';
}

/**
 * Whether this auditor decision will create a reusable dynamic authorization.
 * Exactly one combination does: the model recommended DENY and the auditor
 * overrides to FORCE_ALLOW. Everything else, including a failed generation,
 * leaves the authorization set untouched.
 */
export function willCreateAuthorization(recommendation, decision) {
  return decision === 'FORCE_ALLOW'
    && llmAgreement(recommendation, decision) === LLM_AGREEMENT.NOT_AGREED;
}

/**
 * Whether the auditor must supply a reason: any divergence from the model, and
 * any decision taken when no recommendation exists.
 */
export function requiresOverrideReason(recommendation, decision) {
  return llmAgreement(recommendation, decision) !== LLM_AGREEMENT.AGREED;
}

export function authorizationOutcomeNote(recommendation, decision) {
  if (willCreateAuthorization(recommendation, decision)) {
    return 'A dynamic authorization will be created. A future request with exactly '
      + 'this user, record, case, action, purpose and governed conditions will be '
      + 'granted automatically, skipping both the model and the auditor.';
  }
  const view = recommendationView(recommendation);
  if (!view.available) {
    return 'No dynamic authorization is created, because no recommendation exists to override.';
  }
  return 'No dynamic authorization is created. Only a model DENY overridden to '
    + 'FORCE ALLOW produces one.';
}

/**
 * May this auditor decide this request, and if not, why?
 *
 * Two rules the chaincode and the backend enforce, checked here first so the
 * screen can say so before the auditor presses a button rather than after:
 * the identity that raised a request may never decide it, and a decision waits
 * until the LLM recommendation (or its failure) is stored, because the ledger
 * records whether the decision agreed with it.
 */
export function decisionAvailability(review, viewerUsername) {
  const requester = review?.request?.requester?.username;
  if (!review || !viewerUsername || !requester) {
    return {
      allowed: false,
      reason: 'unknown-viewer',
      message: 'This request could not be matched to the signed-in identity.',
    };
  }
  if (requester === viewerUsername) {
    return {
      allowed: false,
      reason: 'own-request',
      message: `You raised this request as ${requester}. A different AuditMSP district head `
        + 'must decide it — the chaincode refuses a decision by the requester.',
    };
  }
  if (['pending', 'signed'].includes(review.recommendationState)) {
    return {
      allowed: false,
      reason: 'recommendation-pending',
      message: 'The LLM recommendation is still being prepared or committed to the ledger. '
        + 'The decision is compared with the committed recommendation, so it waits for it.',
    };
  }
  const integrity = recommendationIntegrity(review);
  if (integrity.status === 'mismatch' || integrity.status === 'missing-object') {
    return {
      allowed: false,
      reason: 'integrity-mismatch',
      message: `The recommendation shown here does not match its ledger commitment (${integrity.problems.join('; ')}). `
        + 'No decision can be recorded until it is restored.',
    };
  }
  return { allowed: true, reason: null, message: null };
}

/** One row of the auditor queue / review screen, flattened from the API shape. */
export function reviewSummary(review) {
  const request = review?.request || {};
  const verified = request.verifiedRequest || {};
  const requester = verified.requester || {};
  const resource = verified.resource || {};
  const asked = verified.request || {};
  const recommendation = recommendationView(review?.recommendation, review?.recommendationState);
  return {
    requestId: request.requestId,
    stableUserId: request.requester?.stableUserId,
    username: request.requester?.username,
    role: requester.role,
    organization: requester.organization,
    mspId: requester.mspId,
    rank: requester.rank,
    station: requester.station,
    jurisdiction: requester.jurisdiction,
    clearance: requester.clearance,
    credentialStatus: requester.credentialStatus,
    assignedToRequestedCase: requester.assignedToRequestedCase,
    recordId: request.recordId,
    caseId: request.caseId,
    recordType: resource.recordType,
    sensitivity: resource.sensitivityLevel,
    recordJurisdiction: resource.jurisdiction,
    owningAgency: resource.owningAgency,
    owningStation: resource.owningStation,
    sealed: resource.sealed,
    juvenileFlag: resource.juvenileFlag,
    witnessFlag: resource.witnessFlag,
    victimProtectionFlag: resource.victimProtectionFlag,
    action: asked.action ?? request.action,
    purpose: asked.purpose ?? request.purpose,
    // The requester's own statement, committed as a claim outside the verified
    // context (v3); null on a request that carries no claims record.
    emergencyDeclared: request.requesterClaims ? request.requesterClaims.emergencyDeclared : null,
    justification: review?.justification ?? null,
    llmReason: recommendation.reason ?? null,
    recommendationState: review?.recommendationState ?? 'not-generated',
    recommendation,
    status: request.status,
    submittedAtUtc: request.submittedAtUtc,
  };
}

/** A dynamic authorization row: where it came from and whether it still matches. */
export function authorizationView(authorization) {
  const scope = authorization?.scope || {};
  return {
    authorizationId: authorization?.authorizationId,
    status: authorization?.status,
    active: authorization?.status === 'active',
    stateVersion: authorization?.stateVersion,
    generation: authorization?.generation,
    stableUserId: scope.stableUserId,
    recordId: scope.recordId,
    caseId: scope.caseId,
    action: scope.action,
    purpose: scope.purpose,
    conditionsHash: authorization?.conditionsHash,
    validUntilUtc: authorization?.validUntilUtc || null,
    createdAtUtc: authorization?.createdAtUtc,
    originatingRequestId: authorization?.originatingRequestId,
    origin: isDenialOverrideAuthorization(authorization)
      ? 'model DENY → auditor FORCE ALLOW' : 'unexpected origin',
    originValid: isDenialOverrideAuthorization(authorization),
    revocation: authorization?.revocation || null,
  };
}

/** The only origin the design permits. Anything else is a defect worth showing. */
export function isDenialOverrideAuthorization(authorization) {
  return Boolean(authorization
    && authorization.auditorDecision?.decision === 'FORCE_ALLOW'
    && authorization.auditorDecision?.llmAgreement === LLM_AGREEMENT.NOT_AGREED);
}
