'use strict';

/**
 * Who may read what (design §10).
 *
 * Pure rules shared by the contracts. They are interface-level controls: every
 * channel member's peer stores every block, so they govern what a contract
 * returns to a caller, not what a member organisation can read from its own peer.
 */

const { MSP } = require('../util/identity');
const { SEAL_AUTHORITY_ROLES, DISTRICT_HEAD_ROLES } = require('../policy/policyV1');
const { EVENT } = require('./lifecycle');

// Reviewer orgs: auditors, the court, and prosecution can reconstruct trails.
const REVIEWER_MSPS = Object.freeze([MSP.AUDIT, MSP.COURT, MSP.PROSECUTION]);
/**
 * Membership of a reviewer organisation is not by itself oversight authority.
 * Reading a trail requires a district head, or the court authority that can open
 * a sealed record.
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

/**
 * A decision-log entry for a caller outside the reviewer set (design §10, note
 * 2): what was decided and against which recommendation, without who asked, for
 * which record, who decided, or which transactions.
 */
function redactDecisionLogEntry(entry) {
  return {
    redacted: true,
    outcome: entry.outcome,
    basis: entry.basis,
    decision: entry.decision,
    llmRecommendation: entry.llmRecommendation,
    llmAgreement: entry.llmAgreement,
    generationStatus: entry.generationStatus,
    action: entry.action,
    purpose: entry.purpose,
    requester: { organization: entry.requester.organization },
    decidedAtUtc: entry.decidedAtUtc,
  };
}

/**
 * What a requester sees of κ before an auditor has decided: that it exists, not
 * what it says. A requester learns the recommendation with the decision, never
 * ahead of it (author's rule, 2026-10-08).
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

/**
 * The auditor's decision as its requester may see it: without the digest of the
 * auditor's note. The note is never the requester's to read, and the digest is
 * unsalted, so a guessed note could be confirmed against it.
 */
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
  decisionForRequester,
  isAuditor,
  isOwningStation,
  isReviewer,
  isSameDistrictEvidenceMember,
  redactDecisionLogEntry,
  withheldCommitment,
  withholdCommitmentEvent,
  withoutNoteDigestEvent,
};
