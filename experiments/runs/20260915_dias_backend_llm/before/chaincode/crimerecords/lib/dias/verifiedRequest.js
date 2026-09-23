'use strict';

/**
 * The verified request a DIAS recommendation is based on.
 *
 * Built only from committed Fabric state (certificate-bound UserProfile, Case
 * assignment, record metadata) and the requester's committed action and purpose.
 * The recommendation assistant, the synthetic dataset, and the ledger hash all use
 * this exact shape, so what the model sees is what the ledger commits to.
 * Identity (username, enrollment ID) and record/request identifiers are
 * deliberately absent: they are audit facts, not policy facts.
 */

const { hashObject } = require('../util/validate');

const VERIFIED_REQUEST_SCHEMA_VERSION = 'dias-verified-request-v1';

const VERIFIED_REQUEST_FIELDS = Object.freeze({
  requester: Object.freeze([
    'mspId', 'organization', 'role', 'rank', 'station', 'jurisdiction', 'clearance',
    'credentialStatus', 'assignedToRequestedCase',
  ]),
  resource: Object.freeze([
    'recordType', 'caseId', 'sensitivityLevel', 'jurisdiction', 'owningAgency',
    'owningStation', 'sealed', 'juvenileFlag', 'witnessFlag', 'victimProtectionFlag',
  ]),
  request: Object.freeze(['action', 'purpose', 'emergencyFlag', 'approvalTokenPresent']),
});

const BOOLEAN_FIELDS = Object.freeze([
  'assignedToRequestedCase', 'sealed', 'juvenileFlag', 'witnessFlag',
  'victimProtectionFlag', 'emergencyFlag', 'approvalTokenPresent',
]);
const NULLABLE_FIELDS = Object.freeze(['rank', 'station', 'owningAgency', 'owningStation']);

const orNull = (value) => (value === undefined || value === '' ? null : value);

/** Assemble the verified request from governed ledger facts, in canonical key order. */
function buildVerifiedRequest({ subject, record, requestContext, assignedToRequestedCase }) {
  return {
    requester: {
      mspId: subject.mspId,
      organization: orNull(subject.organization),
      role: subject.role,
      rank: orNull(subject.rank),
      station: orNull(subject.station),
      jurisdiction: orNull(subject.jurisdiction),
      clearance: orNull(subject.clearance),
      credentialStatus: subject.credentialStatus,
      assignedToRequestedCase: Boolean(assignedToRequestedCase),
    },
    resource: {
      recordType: record.recordType,
      caseId: record.caseId,
      sensitivityLevel: orNull(record.sensitivityLevel),
      jurisdiction: orNull(record.jurisdiction),
      owningAgency: orNull(record.owningAgency),
      owningStation: orNull(record.owningStation),
      sealed: Boolean(record.sealed),
      juvenileFlag: Boolean(record.juvenileFlag),
      witnessFlag: Boolean(record.witnessFlag),
      victimProtectionFlag: Boolean(record.victimProtectionFlag),
    },
    request: {
      action: requestContext.action,
      purpose: requestContext.purpose,
      emergencyFlag: Boolean(requestContext.emergencyFlag),
      approvalTokenPresent: Boolean(requestContext.approvalTokenPresent),
    },
  };
}

function fieldProblems(group, value) {
  const expected = VERIFIED_REQUEST_FIELDS[group];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${group} must be an object`];
  }
  const keys = Object.keys(value).sort().join(',');
  if (keys !== [...expected].sort().join(',')) {
    return [`${group} must contain exactly ${expected.join(', ')}`];
  }
  return expected.flatMap((field) => {
    const item = value[field];
    if (BOOLEAN_FIELDS.includes(field)) {
      return typeof item === 'boolean' ? [] : [`${group}.${field} must be a boolean`];
    }
    if (item === null && NULLABLE_FIELDS.includes(field)) return [];
    return typeof item === 'string' && item.length > 0 && item.length <= 128
      ? [] : [`${group}.${field} must be a non-empty string`];
  });
}

/** Problems with a verified request; an empty list means it is well formed. */
function validateVerifiedRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['verified request must be an object'];
  }
  const groups = Object.keys(VERIFIED_REQUEST_FIELDS);
  if (Object.keys(value).sort().join(',') !== [...groups].sort().join(',')) {
    return [`verified request must contain exactly ${groups.join(', ')}`];
  }
  return groups.flatMap((group) => fieldProblems(group, value[group]));
}

/** Same content in canonical key order, for deterministic prompt rendering. */
function orderedVerifiedRequest(value) {
  return Object.fromEntries(Object.entries(VERIFIED_REQUEST_FIELDS).map(
    ([group, fields]) => [group, Object.fromEntries(fields.map((field) => [field, value[group][field]]))]
  ));
}

function verifiedRequestHash(value) {
  return hashObject(orderedVerifiedRequest(value));
}

module.exports = {
  VERIFIED_REQUEST_FIELDS,
  VERIFIED_REQUEST_SCHEMA_VERSION,
  buildVerifiedRequest,
  orderedVerifiedRequest,
  validateVerifiedRequest,
  verifiedRequestHash,
};
