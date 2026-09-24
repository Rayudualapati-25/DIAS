/**
 * Domain vocabulary, in one place.
 *
 * These lists must match the chaincode. When you add a record type, purpose or
 * reason code to `chaincode/crimerecords/lib/policy/policyV1.js`, add it here
 * too — that is the only frontend change needed for the dropdowns and wording.
 */

export const RECORD_TYPES = Object.freeze([
  'fir', 'case-diary', 'evidence', 'forensic-report',
  'witness-statement', 'chargesheet', 'court-order',
]);

export const SENSITIVITY = Object.freeze(['low', 'medium', 'high']);

export const ACTIONS = Object.freeze(['view', 'export', 'annotate']);

export const PURPOSES = Object.freeze([
  'investigation', 'forensic-analysis', 'prosecution',
  'judicial-proceeding', 'audit-review', 'defense-preparation',
]);

/** The purpose a given role would normally state, used to preselect dropdowns. */
export const DEFAULT_PURPOSE_BY_ROLE = Object.freeze({
  'lab-analyst': 'forensic-analysis',
  'lab-director': 'forensic-analysis',
  'public-prosecutor': 'prosecution',
  'defense-counsel': 'defense-preparation',
  judge: 'judicial-proceeding',
  magistrate: 'judicial-proceeding',
  'court-clerk': 'judicial-proceeding',
  auditor: 'audit-review',
  ombudsman: 'audit-review',
});

export function defaultPurpose(role) {
  return DEFAULT_PURPOSE_BY_ROLE[role] || 'investigation';
}

export const ACTION_LABELS = Object.freeze({
  view: 'View', export: 'Export', annotate: 'Annotate',
});

export const PURPOSE_LABELS = Object.freeze({
  investigation: 'Investigation',
  'forensic-analysis': 'Forensic analysis',
  prosecution: 'Prosecution',
  'judicial-proceeding': 'Judicial proceeding',
  'audit-review': 'Audit review',
  'defense-preparation': 'Defence preparation',
});

export const requestActionLabel = (value) => ACTION_LABELS[value] || value;
export const purposeLabel = (value) => PURPOSE_LABELS[value] || value;

/**
 * Plain-English sentence per reason code defined by the governance policy
 * bundle. Every code here maps to exactly one recommendation class, matching
 * `policies/dias-governance-policy-v1.json`.
 */
export const REASON_TEXT = Object.freeze({
  POLICY_SATISFIED: 'All policy gates passed for this role, purpose, and record sensitivity.',
  CRED_NOT_ACTIVE: 'The requester credential is not active (suspended or revoked).',
  INVALID_PURPOSE: 'No valid declared purpose was supplied with the request.',
  RBAC_NO_PERMISSION: 'This role has no permission for that action on that record type.',
  SEALED_RECORD: 'The record is sealed by the court, so the court must decide.',
  JUVENILE_PROTECTED: 'The record involves a juvenile and this role is not permitted to see it.',
  VICTIM_DATA_NOT_NECESSARY: 'The forensic role does not require victim-protected raw data for this task.',
  CROSS_JURISDICTION: 'The record belongs to another district. No role reaches across a district boundary.',
  NOT_ASSIGNED: 'The requester is not assigned to this case.',
  INSUFFICIENT_CLEARANCE: 'The requester clearance is below the record sensitivity level.',
});

/**
 * Why no recommendation exists. These are generation statuses, not
 * recommendations: the model produced nothing, and the auditor still decides.
 */
export const GENERATION_STATUS_TEXT = Object.freeze({
  UNAVAILABLE: 'The policy model could not be reached or did not answer in time.',
  INVALID_OUTPUT: 'The policy model returned something that is not a valid recommendation.',
  POLICY_CONTEXT_UNAVAILABLE: 'The governance policy context could not be assembled for this request.',
  CONTEXT_OVERFLOW: 'The request and policy did not fit within the model context window.',
});

/** Review flags the policy defines, in plain language. */
export const REVIEW_FLAG_TEXT = Object.freeze({
  SEALED_RECORD_COURT_REVIEW: 'The record is sealed; a court review is the appropriate route.',
  UNVERIFIED_CLAIM_IN_JUSTIFICATION: 'The justification asserts something the verified facts do not support.',
  INSTRUCTION_IN_JUSTIFICATION: 'The justification tries to instruct the model rather than explain the need.',
});

/** What a committed access outcome means for the requester. */
export const OUTCOME_CONSEQUENCE = Object.freeze({
  granted: 'The file can be opened.',
  denied: 'The file stays closed. You can ask the authority in your chain of command to review it.',
});

/** Human labels for access-log action names. */
export const ACTION_LABEL = Object.freeze({
  'record.search': 'searched case files',
  'record.read': 'opened record metadata',
  'record.create': 'filed a record',
  'record.seal': 'sealed a record',
  'record.unseal': 'unsealed a record',
  'payload.release': 'received the case file',
  'evidence.attach': 'attached evidence',
  'evidence.list': 'listed evidence',
  'evidence.detail.read': 'read private evidence detail',
  'access.request': 'submitted a DIAS access request',
  'access.request.trail': 'read a request audit trail',
  'dias.auditor.queue.read': 'viewed the DIAS auditor queue',
  'dias.auditor.review.read': 'opened a DIAS auditor review',
  'dias.auditor.decision': 'recorded the auditor final decision',
  'dias.authorization.list': 'listed dynamic authorizations',
  'dias.authorization.read': 'inspected a dynamic authorization',
  'dias.authorization.history': 'viewed dynamic authorization history',
  'dias.authorization.revoke': 'revoked a dynamic authorization',
  'decision.read': 'checked an access decision',
  'decision.list': 'listed access decisions',
  'record.metadata.read': 'opened case-file metadata',
  'document.request.create': 'requested the full case file',
  'document.request.list': 'checked PDF requests',
  'document.upload': 'uploaded a case-file PDF',
  'document.release': 'received a case-file PDF',
  'case.list': 'listed cases',
  'case.read': 'looked up a case',
  'access.request.read': 'checked a DIAS request',
  'audit.trail.read': 'read the audit trail',
  'audit.request-trail.read': 'read a request lifecycle trail',
  'audit.verify.payload': 'verified payload integrity',
  'audit.verify.recommendation-reason': 'verified a recommendation explanation',
  'audit.accesslog.read': 'read the access log',
  'explanation.render': 'viewed a plain-language explanation',
  'auth.login': 'signed in',
  'auth.login_failed': 'failed sign-in',
  'auth.whoami': 'checked their profile',
});

export function actionLabel(action) {
  return ACTION_LABEL[action] || action;
}

/** Colour for an outcome pill. */
export function outcomeKind(outcome) {
  if (outcome === 'ok') return 'allow';
  if (outcome === 'refused' || outcome === 'failed') return 'deny';
  return 'neutral';
}
