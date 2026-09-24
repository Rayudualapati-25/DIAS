'use strict';

const { expect } = require('chai');
const {
  VERIFIED_REQUEST_FIELDS, buildVerifiedRequest, orderedVerifiedRequest,
  validateVerifiedRequest, verifiedRequestHash,
} = require('../lib/dias/verifiedRequest');
const {
  FAILURE_STATUSES, normalizeRecommendation, validateRecommendationOutput,
} = require('../lib/dias/recommendationSchema');

const POLICY = Object.freeze({
  clauseRefs: ['GP-RBAC:C2@v1', 'GP-DEFAULT:C1@v1', 'GP-JURIS:C1@v1'],
  reasonCodes: { POLICY_SATISFIED: 'ALLOW', CROSS_JURISDICTION: 'DENY' },
  reviewFlags: ['UNVERIFIED_CLAIM_IN_JUSTIFICATION'],
});

function verified() {
  return buildVerifiedRequest({
    subject: {
      mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3', station: '',
      jurisdiction: 'district-north', clearance: 'high', credentialStatus: 'active',
    },
    record: {
      recordType: 'fir', caseId: 'CASE-1', sensitivityLevel: 'medium', jurisdiction: 'district-north',
      owningAgency: 'police', owningStation: undefined, sealed: 0, juvenileFlag: undefined,
      witnessFlag: 'yes', victimProtectionFlag: false,
    },
    requestContext: { action: 'view', purpose: 'investigation' },
    assignedToRequestedCase: 1,
  });
}

function output(overrides = {}) {
  return {
    recommendation: 'ALLOW', reason_code: 'POLICY_SATISFIED', reason: 'Permitted.',
    policy_refs: ['GP-RBAC:C2@v1', 'GP-DEFAULT:C1@v1'], missing_evidence: [], review_flags: [],
    ...overrides,
  };
}

describe('DIAS verified request', () => {
  it('builds the documented shape with booleans and nulls normalized', () => {
    const value = verified();
    expect(validateVerifiedRequest(value)).to.deep.equal([]);
    expect(value.requester.station).to.equal(null);
    expect(value.resource.owningStation).to.equal(null);
    expect(value.requester.assignedToRequestedCase).to.equal(true);
    expect(value.resource.sealed).to.equal(false);
    expect(value.resource.witnessFlag).to.equal(true);
    expect(value.request.emergencyFlag).to.equal(false);
    for (const [group, fields] of Object.entries(VERIFIED_REQUEST_FIELDS)) {
      expect(Object.keys(value[group])).to.deep.equal([...fields]);
    }
  });

  it('rejects missing groups, extra fields, and wrong types', () => {
    expect(validateVerifiedRequest(null)).to.have.length(1);
    const extra = verified();
    extra.requester.username = 'insp.sharma';
    expect(validateVerifiedRequest(extra)[0]).to.match(/requester must contain exactly/);
    const wrongType = verified();
    wrongType.resource.sealed = 'false';
    expect(validateVerifiedRequest(wrongType)).to.deep.equal(['resource.sealed must be a boolean']);
    const emptyRole = verified();
    emptyRole.requester.role = '';
    expect(validateVerifiedRequest(emptyRole)).to.deep.equal(['requester.role must be a non-empty string']);
    expect(validateVerifiedRequest({ requester: {} })[0]).to.match(/must contain exactly/);
  });

  it('hashes independently of key order', () => {
    const value = verified();
    const reordered = {
      request: { ...value.request },
      resource: Object.fromEntries(Object.entries(value.resource).reverse()),
      requester: value.requester,
    };
    expect(verifiedRequestHash(reordered)).to.equal(verifiedRequestHash(value));
    expect(Object.keys(orderedVerifiedRequest(reordered))).to.deep.equal(['requester', 'resource', 'request']);
  });
});

describe('DIAS recommendation schema', () => {
  it('accepts a valid response and normalizes key order', () => {
    expect(validateRecommendationOutput(output(), POLICY)).to.deep.equal([]);
    const reordered = Object.fromEntries(Object.entries(output()).reverse());
    expect(Object.keys(normalizeRecommendation(reordered))[0]).to.equal('recommendation');
  });

  it('allows only binary recommendations with matching reason codes', () => {
    expect(validateRecommendationOutput(output({ recommendation: 'ESCALATE' }), POLICY))
      .to.include('recommendation must be ALLOW or DENY');
    expect(validateRecommendationOutput(output({ reason_code: 'CROSS_JURISDICTION' }), POLICY))
      .to.include('reason_code does not belong to the recommendation');
    expect(validateRecommendationOutput(output({ reason_code: 'MODEL_POLICY_DISAGREEMENT' }), POLICY))
      .to.include('reason_code is not defined by the policy');
  });

  it('validates lists against the registered policy vocabulary', () => {
    expect(validateRecommendationOutput(output({ policy_refs: 'GP-DEFAULT:C1@v1' }), POLICY)[0])
      .to.match(/policy_refs must be a list/);
    expect(validateRecommendationOutput(output({ policy_refs: ['GP-X:C1@v1'] }), POLICY)[0])
      .to.match(/undefined entries/);
    expect(validateRecommendationOutput(output({ review_flags: ['X', 'X'] }), POLICY))
      .to.have.length(2);
    expect(validateRecommendationOutput(output({ missing_evidence: [''] }), POLICY)[0])
      .to.match(/missing_evidence/);
    expect(validateRecommendationOutput([], POLICY)).to.deep.equal(['response must be a JSON object']);
    expect(validateRecommendationOutput({ recommendation: 'ALLOW' }, POLICY)[0]).to.match(/exactly/);
  });

  it('separates generation failures from recommendations', () => {
    expect(FAILURE_STATUSES).to.deep.equal([
      'UNAVAILABLE', 'INVALID_OUTPUT', 'POLICY_CONTEXT_UNAVAILABLE', 'CONTEXT_OVERFLOW',
    ]);
  });
});
