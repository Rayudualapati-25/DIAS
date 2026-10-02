'use strict';

/**
 * Who may act as a DIAS auditor at the moment of a decision or a revocation.
 *
 * The certificate says what an identity was enrolled as; the ledger profile says
 * what it is now. A district head in the authority organisation may decide only
 * while both are active and agree with each other, and only for a record held in
 * the district they head and at a sensitivity their clearance covers
 * (lib/policy/authority.js defines a district head by jurisdiction and clearance).
 * Every failure throws before anything is written, so a rejected transaction
 * leaves the ledger unchanged.
 */

const { MSP, getCaller, requireMsp, requireRole } = require('../util/identity');
const { DISTRICT_HEAD_ROLES } = require('../policy/policyV1');
const { holdsClearance } = require('../policy/authority');
const KEYS = require('./keys');

const ORG_TO_MSP = Object.freeze({
  police: MSP.POLICE,
  forensics: MSP.FORENSICS,
  prosecution: MSP.PROSECUTION,
  court: MSP.COURT,
  audit: MSP.AUDIT,
});
const MATCHED_ATTRIBUTES = Object.freeze(['rank', 'station', 'jurisdiction', 'clearance']);

async function readProfile(ctx, enrollmentId) {
  const data = await ctx.stub.getState(ctx.stub.createCompositeKey(KEYS.USER, [enrollmentId]));
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

/** The certificate and the profile must describe the same person and posting. */
function assertCertificateMatchesProfile(caller, profile) {
  if (profile.fabricUser !== caller.enrollmentId
      || ORG_TO_MSP[profile.org] !== caller.mspId
      || profile.role !== caller.role) {
    throw new Error('unauthorized: certificate does not match the UserProfile');
  }
  for (const attribute of MATCHED_ATTRIBUTES) {
    if (profile[attribute] && caller[attribute] !== profile[attribute]) {
      throw new Error(`unauthorized: certificate ${attribute} does not match UserProfile`);
    }
  }
}

/** Organisation and role from the certificate, checked before any state is read. */
function requireDistrictHeadCertificate(ctx, action) {
  const caller = getCaller(ctx);
  requireMsp(caller, [MSP.AUDIT], action);
  requireRole(caller, [...DISTRICT_HEAD_ROLES], action);
  return caller;
}

/**
 * The full auditor check. `record` is the record the act concerns; without one
 * (governance acts) only the credential and profile are checked.
 */
async function requireActiveDistrictHead(ctx, { action, record = null, caller = null }) {
  const certified = caller || requireDistrictHeadCertificate(ctx, action);
  if (certified.credentialStatus !== 'active') {
    throw new Error(`DIAS_AUDITOR_INACTIVE: the certificate credential is ${certified.credentialStatus || 'missing'}`);
  }
  if (!certified.enrollmentId) {
    throw new Error('DIAS_AUDITOR_INACTIVE: the certificate has no enrollment identity');
  }
  const profile = await readProfile(ctx, certified.enrollmentId);
  if (!profile) {
    throw new Error(`DIAS_AUDITOR_INACTIVE: '${certified.enrollmentId}' has no ledger profile`);
  }
  assertCertificateMatchesProfile(certified, profile);
  if (profile.credentialStatus !== 'active') {
    throw new Error(`DIAS_AUDITOR_INACTIVE: the ledger profile is ${profile.credentialStatus}`);
  }
  if (record) {
    if (profile.jurisdiction !== record.jurisdiction) {
      throw new Error(
        `DIAS_AUDITOR_OUT_OF_DISTRICT: ${action} for a record in '${record.jurisdiction}' `
        + `requires a district head of that district, not of '${profile.jurisdiction}'`
      );
    }
    if (!holdsClearance(profile, record.sensitivityLevel)) {
      throw new Error(
        `DIAS_AUDITOR_CLEARANCE: clearance '${profile.clearance}' does not cover `
        + `a '${record.sensitivityLevel}' record`
      );
    }
  }
  return { caller: certified, profile };
}

module.exports = {
  assertCertificateMatchesProfile,
  requireActiveDistrictHead,
  requireDistrictHeadCertificate,
};
