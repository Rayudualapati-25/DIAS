'use strict';

const {
  buildVerifiedRequest,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const verifiedRequestV1 = require('../../../chaincode/crimerecords/lib/dias/verifiedRequestV1');
const {
  buildRequesterClaims,
} = require('../../../chaincode/crimerecords/lib/dias/requesterClaims');

const SUBJECT = Object.freeze({
  mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3',
  station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high',
  credentialStatus: 'active',
});
const RECORD = Object.freeze({
  recordType: 'fir', caseId: 'CASE-7F2A', sensitivityLevel: 'medium',
  jurisdiction: 'district-north', owningAgency: 'police', owningStation: 'PS-Central',
  sealed: false, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
});

function withOverrides(base, overrides = {}) {
  return {
    requester: { ...base.requester, ...overrides.requester },
    resource: { ...base.resource, ...overrides.resource },
    request: { ...base.request, ...overrides.request },
  };
}

/** The v3 verified context C: facts only, no requester claims. */
function verifiedRequestFixture(overrides = {}) {
  return withOverrides(buildVerifiedRequest({
    subject: SUBJECT,
    record: RECORD,
    requestContext: { action: 'view', purpose: 'investigation' },
    assignedToRequestedCase: true,
  }), overrides);
}

/** The historical v1 verified request (prompt v1, the published dataset). */
function verifiedRequestV1Fixture(overrides = {}) {
  return withOverrides(verifiedRequestV1.buildVerifiedRequest({
    subject: SUBJECT,
    record: RECORD,
    requestContext: {
      action: 'view', purpose: 'investigation', emergencyFlag: false, approvalTokenPresent: false,
    },
    assignedToRequestedCase: true,
  }), overrides);
}

function requesterClaimsFixture(overrides = {}) {
  return buildRequesterClaims({ emergencyDeclared: false, ...overrides });
}

function validOutput(overrides = {}) {
  return {
    recommendation: 'ALLOW',
    reason_code: 'POLICY_SATISFIED',
    reason: 'Role inspector may view fir records and no DENY clause applies (GP-RBAC:C2@v1, GP-DEFAULT:C1@v1).',
    policy_refs: ['GP-RBAC:C2@v1', 'GP-DEFAULT:C1@v1'],
    missing_evidence: [],
    review_flags: [],
    ...overrides,
  };
}

module.exports = {
  requesterClaimsFixture, validOutput, verifiedRequestFixture, verifiedRequestV1Fixture,
};
