'use strict';

const {
  buildVerifiedRequest,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');

function verifiedRequestFixture(overrides = {}) {
  const base = buildVerifiedRequest({
    subject: {
      mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3',
      station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high',
      credentialStatus: 'active',
    },
    record: {
      recordType: 'fir', caseId: 'CASE-7F2A', sensitivityLevel: 'medium',
      jurisdiction: 'district-north', owningAgency: 'police', owningStation: 'PS-Central',
      sealed: false, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
    },
    requestContext: {
      action: 'view', purpose: 'investigation', emergencyFlag: false, approvalTokenPresent: false,
    },
    assignedToRequestedCase: true,
  });
  return {
    requester: { ...base.requester, ...overrides.requester },
    resource: { ...base.resource, ...overrides.resource },
    request: { ...base.request, ...overrides.request },
  };
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

module.exports = { validOutput, verifiedRequestFixture };
