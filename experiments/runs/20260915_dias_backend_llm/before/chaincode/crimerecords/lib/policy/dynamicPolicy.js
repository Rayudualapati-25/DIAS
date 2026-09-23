'use strict';

/**
 * DIAS exact-match dynamic access policy.
 *
 * These helpers contain no Fabric APIs so the fingerprint and rule-origin
 * contract can be tested independently from chaincode state. Authorization and
 * state transitions remain in AccessContract.
 */

const { hashObject, sha256, SAFE_ID } = require('../util/validate');

const FINGERPRINT_VERSION = 'dias-request-fingerprint-v1';
const DYNAMIC_RULE_SCHEMA_VERSION = 'dias-dynamic-rule-v1';

const nullable = (value) => (value === undefined || value === '' ? null : value);

function assignedToCase(caseAssignments, caseId) {
  if (Array.isArray(caseAssignments)) return caseAssignments.includes(caseId);
  if (typeof caseAssignments !== 'string') return false;
  return caseAssignments.split(/[,|]/).map((value) => value.trim()).includes(caseId);
}

/**
 * Build the authorization identity of a request.
 *
 * recordId, caseId, contentHash, offChainReference and free text are
 * deliberately excluded. A different record may reuse a rule only when every
 * governed security property and the requester's assignment status match.
 */
function buildRequestFingerprint({ governed, record, requestContext }) {
  if (!governed || !record || !requestContext) {
    throw new Error('governed subject, record, and request context are required');
  }
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    subject: {
      username: nullable(governed.enrollmentId),
      mspId: nullable(governed.mspId),
      organization: nullable(governed.organization),
      role: nullable(governed.role),
      rank: nullable(governed.rank),
      station: nullable(governed.station),
      jurisdiction: nullable(governed.jurisdiction),
      clearance: nullable(governed.clearance),
      credentialStatus: nullable(governed.credentialStatus),
      assignedToRequestedCase: assignedToCase(
        governed.caseAssignments, record.caseId
      ),
    },
    request: {
      action: nullable(requestContext.action),
      purpose: nullable(requestContext.purpose),
    },
    record: {
      recordType: nullable(record.recordType),
      sensitivityLevel: nullable(record.sensitivityLevel),
      jurisdiction: nullable(record.jurisdiction),
      owningAgency: nullable(record.owningAgency),
      owningStation: nullable(record.owningStation),
      sealed: Boolean(record.sealed),
      juvenileFlag: Boolean(record.juvenileFlag),
      witnessFlag: Boolean(record.witnessFlag),
      victimProtectionFlag: Boolean(record.victimProtectionFlag),
    },
  };
}

function fingerprintHash(fingerprint) {
  return hashObject(fingerprint);
}

/**
 * Materialize the only rule origin DIAS accepts. The caller must already have
 * verified the referenced ledger assets; this helper additionally makes an
 * invalid transition unrepresentable in the stored rule schema.
 */
function createDynamicAccessRuleAsset({
  txId,
  timestamp,
  auditor,
  fingerprint,
  sourceRequestId,
  sourceRecommendationId,
  sourceAuditorDecisionId,
  llmRecommendation,
  auditorDecision,
  ruleVersion = 1,
}) {
  if (String(llmRecommendation || '').toLowerCase() !== 'deny') {
    throw new Error('a dynamic rule requires an LLM DENY recommendation');
  }
  if (String(auditorDecision || '').toLowerCase().replace(/_/g, '-') !== 'force-allow') {
    throw new Error('a dynamic rule requires an auditor FORCE_ALLOW decision');
  }
  if (!auditor || !auditor.enrollmentId || !auditor.mspId || !auditor.role || !auditor.id) {
    throw new Error('the creating auditor identity is incomplete');
  }
  const sourceIds = {
    sourceRequestId, sourceRecommendationId, sourceAuditorDecisionId,
  };
  for (const [field, value] of Object.entries(sourceIds)) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
      throw new Error(`${field} has invalid format`);
    }
  }
  if (typeof txId !== 'string' || !SAFE_ID.test(txId)) {
    throw new Error('txId has invalid format');
  }
  if (typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw new Error('timestamp must be an ISO-8601 date-time string');
  }
  if (!fingerprint || fingerprint.fingerprintVersion !== FINGERPRINT_VERSION) {
    throw new Error('the request fingerprint is invalid');
  }
  if (!Number.isInteger(ruleVersion) || ruleVersion < 1) {
    throw new Error('ruleVersion must be a positive integer');
  }

  return {
    docType: 'dynamicAccessRule',
    schemaVersion: DYNAMIC_RULE_SCHEMA_VERSION,
    ruleId: txId,
    ruleVersion,
    status: 'active',
    fingerprint,
    fingerprintHash: fingerprintHash(fingerprint),
    sourceRequestId,
    sourceRecommendationId,
    sourceAuditorDecisionId,
    sourceLlmRecommendation: 'deny',
    sourceAuditorDecision: 'force-allow',
    createdByUsername: auditor.enrollmentId,
    createdByIdentityHash: sha256(auditor.id),
    createdByMsp: auditor.mspId,
    createdByRole: auditor.role,
    createdAtUtc: timestamp,
    creationTxId: txId,
    revokedByUsername: null,
    revokedByIdentityHash: null,
    revokedByMsp: null,
    revokedByRole: null,
    revokedAtUtc: null,
    revocationTxId: null,
    revocationReason: null,
  };
}

module.exports = {
  DYNAMIC_RULE_SCHEMA_VERSION,
  FINGERPRINT_VERSION,
  buildRequestFingerprint,
  createDynamicAccessRuleAsset,
  fingerprintHash,
};
