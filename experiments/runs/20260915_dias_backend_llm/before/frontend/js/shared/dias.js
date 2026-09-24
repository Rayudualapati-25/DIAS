/**
 * Pure DIAS view-model helpers shared by the requester and auditor screens.
 *
 * The vocabulary here is deliberately strict about one thing: a recommendation
 * is not a decision. `recommendationView` never produces an outcome, and
 * `outcomeView` never reads the model's answer. Keeping the two apart in the
 * view model is what stops a screen from showing "DENY" as though access had
 * been refused when no auditor has looked at it yet.
 */

/** The four request statuses the chaincode can commit. */
export const STATUS = Object.freeze({
  AWAITING_RECOMMENDATION: 'awaiting-recommendation',
  AWAITING_AUDITOR: 'awaiting-auditor',
  GRANTED: 'granted',
  DENIED: 'denied',
});

const FINAL = Object.freeze([STATUS.GRANTED, STATUS.DENIED]);

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
  if (request?.status === STATUS.AWAITING_AUDITOR) return 'waiting for auditor';
  return 'waiting for the policy model';
}

/** Who actually decided. Never the model. */
export function decisionAuthorityLabel(request) {
  if (isAutomaticGrant(request)) return 'Active dynamic authorization';
  if (isSettled(request)) return 'AuditMSP auditor';
  return 'Not yet decided';
}

/**
 * The model's advisory answer, or an explicit statement that none exists.
 * `generationStatus` other than OK means the model produced nothing; the
 * auditor still decides, and the screen must say so rather than show a blank.
 */
export function recommendationView(recommendation) {
  if (!recommendation) {
    return { available: false, status: 'PENDING', label: 'not yet recorded', advisory: true };
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
    policyRefs: recommendation.policyRefs || [],
    missingEvidence: recommendation.missingEvidence || [],
    reviewFlags: recommendation.reviewFlags || [],
    advisory: true,
  };
}

/**
 * Whether this auditor decision will create a reusable dynamic authorization.
 * Exactly one combination does: the model recommended DENY and the auditor
 * overrides to FORCE_ALLOW. Everything else, including a failed generation,
 * leaves the authorization set untouched.
 */
export function willCreateAuthorization(recommendation, decision) {
  const view = recommendationView(recommendation);
  return view.available && view.recommendation === 'DENY' && decision === 'FORCE_ALLOW';
}

/**
 * Whether the auditor must supply a reason: any divergence from the model, and
 * any decision taken when no recommendation exists.
 */
export function requiresOverrideReason(recommendation, decision) {
  const view = recommendationView(recommendation);
  if (!view.available) return true;
  return (view.recommendation === 'DENY' && decision === 'FORCE_ALLOW')
    || (view.recommendation === 'ALLOW' && decision === 'FORCE_DENY');
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

/** One row of the auditor queue / review screen, flattened from the chaincode shape. */
export function reviewSummary(review) {
  const request = review?.request || {};
  const verified = request.verifiedRequest || {};
  const requester = verified.requester || {};
  const resource = verified.resource || {};
  const asked = verified.request || {};
  const recommendation = recommendationView(review?.recommendation);
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
    emergencyFlag: asked.emergencyFlag,
    justification: review?.justification ?? null,
    justificationHashVerified: Boolean(review?.justificationHashVerified),
    llmReason: review?.llmReason ?? null,
    llmReasonHashVerified: Boolean(review?.llmReasonHashVerified),
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
    && authorization.originalLlmRecommendation?.recommendation === 'DENY'
    && authorization.auditorDecision?.decision === 'FORCE_ALLOW');
}
