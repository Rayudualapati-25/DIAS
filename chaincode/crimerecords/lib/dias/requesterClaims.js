'use strict';

/**
 * Requester claims K (dias-requester-claims-v1): what the requester asserts but
 * the ledger cannot verify. They are committed with the request and shown to the
 * recommendation model and the auditor as claims, never inside the verified
 * context C. Their digest h_K (domain `claims`) is bound into the signed
 * recommendation provenance, so the model's input claims cannot be changed
 * unnoticed (docs/design/dias-v3-ledger-schema.md §3, §6.1).
 */

const { DOMAINS, hashCanonical } = require('./commitments');

const REQUESTER_CLAIMS_SCHEMA_VERSION = 'dias-requester-claims-v1';
const CLAIM_FIELDS = Object.freeze(['emergencyDeclared']);

function buildRequesterClaims({ emergencyDeclared } = {}) {
  return { emergencyDeclared: emergencyDeclared === true };
}

function validateRequesterClaims(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['claims must be an object'];
  if (Object.keys(value).sort().join(',') !== [...CLAIM_FIELDS].sort().join(',')) {
    return [`claims must contain exactly ${CLAIM_FIELDS.join(', ')}`];
  }
  return typeof value.emergencyDeclared === 'boolean' ? [] : ['claims.emergencyDeclared must be a boolean'];
}

/** h_K. */
function requesterClaimsHash(value) {
  return hashCanonical(DOMAINS.CLAIMS, { emergencyDeclared: value.emergencyDeclared });
}

module.exports = {
  CLAIM_FIELDS,
  REQUESTER_CLAIMS_SCHEMA_VERSION,
  buildRequesterClaims,
  requesterClaimsHash,
  validateRequesterClaims,
};
