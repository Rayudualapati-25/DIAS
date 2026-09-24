'use strict';

/**
 * Caller identity helpers.
 *
 * Every authorization decision in this chaincode goes through here, reading
 * the caller's MSP and X.509 attributes from the transaction context. This is
 * the fix for the "no authorization" finding in the previous audit chaincode:
 * nothing is trusted from request payloads, only from the signed identity.
 */

const MSP = Object.freeze({
  POLICE: 'PoliceMSP',
  FORENSICS: 'ForensicsMSP',
  PROSECUTION: 'ProsecutionMSP',
  COURT: 'CourtMSP',
  AUDIT: 'AuditMSP',
});

const ATTRIBUTE_NAMES = Object.freeze([
  'role', 'rank', 'station', 'jurisdiction', 'badgeId', 'clearance',
  'credentialStatus', 'caseAssignments',
]);

/**
 * Snapshot the caller's identity attributes. Missing attributes become null;
 * downstream policy rules treat null as "not granted".
 * Returns a new object every call (no shared mutable state).
 */
function getCaller(ctx) {
  const cid = ctx.clientIdentity;
  const id = cid.getID();
  const attrs = {};
  for (const name of ATTRIBUTE_NAMES) {
    const value = cid.getAttributeValue(name);
    attrs[name] = value === undefined || value === null || value === ''
      ? null
      : value;
  }
  return Object.freeze({
    mspId: cid.getMSPID(),
    id,
    enrollmentId: enrollmentIdFromX509Id(id),
    ...attrs,
  });
}

/**
 * Fabric ClientIdentity#getID returns `x509::<subject>::<issuer>`. Depending
 * on the SDK/OpenSSL version, the subject DN is slash- or comma-delimited.
 * Parse only the subject section and accept both canonical encodings.
 */
function enrollmentIdFromX509Id(id) {
  const subject = String(id || '').split('::')[1] || '';
  const match = subject.match(/(?:^|[\/,])CN=([^\/,]+)/);
  return match ? match[1] : null;
}

/** Throw unless the caller belongs to one of the given MSPs. */
function requireMsp(caller, allowedMsps, action) {
  if (!allowedMsps.includes(caller.mspId)) {
    throw new Error(
      `unauthorized: ${action} requires membership in [${allowedMsps.join(', ')}], ` +
      `caller is ${caller.mspId}`
    );
  }
}

/** Throw unless the caller's role attribute is one of the given roles. */
function requireRole(caller, allowedRoles, action) {
  if (caller.role === null || !allowedRoles.includes(caller.role)) {
    throw new Error(
      `unauthorized: ${action} requires role in [${allowedRoles.join(', ')}], ` +
      `caller role is ${caller.role === null ? 'missing' : caller.role}`
    );
  }
}

module.exports = {
  MSP, getCaller, requireMsp, requireRole, enrollmentIdFromX509Id, ATTRIBUTE_NAMES,
};
