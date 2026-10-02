'use strict';

const { expect } = require('chai');
const {
  VERIFIED_REQUEST_FIELDS, VERIFIED_REQUEST_SCHEMA_VERSION, buildVerifiedRequest, orderedVerifiedRequest,
  validateVerifiedRequest, verifiedRequestHash,
} = require('../lib/dias/verifiedRequest');
const verifiedRequestV1 = require('../lib/dias/verifiedRequestV1');
const {
  REQUESTER_CLAIMS_SCHEMA_VERSION, buildRequesterClaims, requesterClaimsHash, validateRequesterClaims,
} = require('../lib/dias/requesterClaims');
const { hashCanonical } = require('../lib/dias/commitments');
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
    // v3: the request part holds only what the requester asked for. A
    // self-declared emergency is a claim, kept outside the verified context, and
    // the approval flag no mechanism ever set is gone (plan step 5).
    expect(value.request).to.deep.equal({ action: 'view', purpose: 'investigation' });
    expect(VERIFIED_REQUEST_SCHEMA_VERSION).to.equal('dias-verified-context-v3');
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

  it('hashes the ordered context in the context domain', () => {
    const value = verified();
    expect(verifiedRequestHash(value)).to.equal(hashCanonical('context', orderedVerifiedRequest(value)));
  });

  it('never carries a requester claim, even when one is passed in', () => {
    const value = buildVerifiedRequest({
      subject: verified().requester,
      record: { ...verified().resource },
      requestContext: { action: 'view', purpose: 'investigation', emergencyFlag: true, approvalTokenPresent: true },
      assignedToRequestedCase: true,
    });
    expect(value.request).to.deep.equal({ action: 'view', purpose: 'investigation' });
    const smuggled = verified();
    smuggled.request.emergencyFlag = true;
    expect(validateVerifiedRequest(smuggled)[0]).to.match(/request must contain exactly action, purpose/);
  });
});

describe('DIAS requester claims', () => {
  it('records the self-declared emergency as a claim with its own digest', () => {
    const claims = buildRequesterClaims({ emergencyDeclared: true });
    expect(claims).to.deep.equal({ emergencyDeclared: true });
    expect(REQUESTER_CLAIMS_SCHEMA_VERSION).to.equal('dias-requester-claims-v1');
    expect(validateRequesterClaims(claims)).to.deep.equal([]);
    expect(requesterClaimsHash(claims)).to.equal(hashCanonical('claims', { emergencyDeclared: true }));
    expect(requesterClaimsHash(buildRequesterClaims({}))).to.not.equal(requesterClaimsHash(claims));
  });

  it('defaults to no emergency and rejects anything but a boolean or extra fields', () => {
    expect(buildRequesterClaims({})).to.deep.equal({ emergencyDeclared: false });
    expect(validateRequesterClaims({ emergencyDeclared: 'yes' })).to.deep.equal(['claims.emergencyDeclared must be a boolean']);
    expect(validateRequesterClaims({ emergencyDeclared: false, approvalTokenPresent: true })[0])
      .to.match(/claims must contain exactly emergencyDeclared/);
    expect(validateRequesterClaims(null)).to.deep.equal(['claims must be an object']);
  });
});

describe('DIAS verified request v1 (historical, prompt v1 and the published dataset)', () => {
  it('keeps the v1 shape with both flags inside the request group, unchanged', () => {
    expect(verifiedRequestV1.VERIFIED_REQUEST_SCHEMA_VERSION).to.equal('dias-verified-request-v1');
    expect([...verifiedRequestV1.VERIFIED_REQUEST_FIELDS.request])
      .to.deep.equal(['action', 'purpose', 'emergencyFlag', 'approvalTokenPresent']);
    const value = verifiedRequestV1.buildVerifiedRequest({
      subject: verified().requester,
      record: { ...verified().resource },
      requestContext: { action: 'view', purpose: 'investigation', emergencyFlag: true },
      assignedToRequestedCase: true,
    });
    expect(verifiedRequestV1.validateVerifiedRequest(value)).to.deep.equal([]);
    expect(value.request).to.deep.equal({
      action: 'view', purpose: 'investigation', emergencyFlag: true, approvalTokenPresent: false,
    });
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
