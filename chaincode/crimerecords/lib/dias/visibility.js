'use strict';

/** Who may read what. */

const { MSP } = require('../util/identity');
const { SEAL_AUTHORITY_ROLES, DISTRICT_HEAD_ROLES } = require('../policy/policyV1');
const { EVENT } = require('./lifecycle');

// Reviewer orgs: auditors, the court, and prosecution can reconstruct trails.
const REVIEWER_MSPS = Object.freeze([MSP.AUDIT, MSP.COURT, MSP.PROSECUTION]);
/**
 * Membership of a reviewer organisation is not by itself oversight authority. Reading a trail requires a
 * district head, or the court authority that can open a sealed record.
 */
const REVIEWER_ROLES = Object.freeze([...SEAL_AUTHORITY_ROLES, ...DISTRICT_HEAD_ROLES]);
/** The organisations that handle evidence; mirrors the evidence collection's members. */
const EVIDENCE_MSPS = Object.freeze([MSP.POLICE, MSP.FORENSICS, MSP.PROSECUTION, MSP.COURT]);

const isReviewer = (caller) => REVIEWER_MSPS.includes(caller.mspId)
  && REVIEWER_ROLES.includes(caller.role);

/** A district head of the audit organisation: the only reader of J, the full M and N. */
const isAuditor = (caller) => caller.mspId === MSP.AUDIT && DISTRICT_HEAD_ROLES.includes(caller.role);

/** A posting gives a member access only while the certificate's credential is active. */
const hasActiveCredential = (caller) => caller.credentialStatus === 'active';

const isOwningStation = (caller, record) => hasActiveCredential(caller)
  && caller.mspId === record.owningMsp
  && Boolean(caller.station) && caller.station === record.owningStation;

const isSameDistrictEvidenceMember = (caller, record) => hasActiveCredential(caller)
  && EVIDENCE_MSPS.includes(caller.mspId)
  && Boolean(caller.jurisdiction) && caller.jurisdiction === record.jurisdiction;

/** Who reads the access log: every officer with an enrolled role whose certificate credential is active. */
const isActiveOfficer = (caller) => Boolean(caller.role) && Boolean(caller.enrollmentId)
  && hasActiveCredential(caller);

/**
 * The authorization check of a request as every officer may read it: what it found, not the digests it
 * compared.
 */
function authorizationCheckResult(check) {
  if (!check) return null;
  return { outcome: check.outcome, matched: check.matched, authorizationId: check.authorizationId };
}

const TRANSACTION_ID_FIELDS = Object.freeze(['requestTxId', 'recommendationTxId', 'decisionTxId', 'outcomeTxId']);

/**
 * A log entry as an officer outside the reviewers reads it: who asked for which file, the advice, the
 * decision and the outcome.
 */
function withoutTransactionIds(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([name]) => !TRANSACTION_ID_FIELDS.includes(name)));
}

/**
 * What a requester sees of κ before an auditor has decided: that it exists, not what it says. A requester
 * learns the recommendation with the decision, never ahead of it.
 */
function withheldCommitment(commitment) {
  return {
    requestId: commitment.requestId,
    commitmentId: commitment.commitmentId,
    withheldUntilDecision: true,
  };
}

/** The same rule for the lifecycle event that recorded the commitment. */
function withholdCommitmentEvent(event) {
  if (event.eventType !== EVENT.RECOMMENDATION_COMMITTED) return event;
  return { ...event, data: { commitmentId: event.data.commitmentId, withheldUntilDecision: true } };
}

const withoutNoteDigest = ({ noteHash: _noteHash, ...rest }) => rest;

/** The auditor's decision as its requester may see it: without the digest of the auditor's note. */
function decisionForRequester(decision) {
  return decision ? withoutNoteDigest(decision) : decision;
}

/** The same rule for the lifecycle event that recorded the decision. */
function withoutNoteDigestEvent(event) {
  if (event.eventType !== EVENT.AUDITOR_DECISION_RECORDED) return event;
  return { ...event, data: withoutNoteDigest(event.data) };
}

module.exports = {
  EVIDENCE_MSPS,
  REVIEWER_MSPS,
  REVIEWER_ROLES,
  authorizationCheckResult,
  decisionForRequester,
  isActiveOfficer,
  isAuditor,
  isOwningStation,
  isReviewer,
  isSameDistrictEvidenceMember,
  withheldCommitment,
  withholdCommitmentEvent,
  withoutNoteDigestEvent,
  withoutTransactionIds,
};
