'use strict';

/**
 * Before an auditor decides, the stored recommendation object M must match its
 * ledger commitment κ: h_M, the value, the status and every binding (paper §IV-D,
 * design §6). Any difference is a mismatch the decision is refused on.
 */

const { expect } = require('chai');
const { checkRecommendationIntegrity } = require('../src/dias/recommendationIntegrity');
const { recommendationHashOf } = require('../src/dias/recommendationObject');

function object(overrides = {}) {
  return {
    schemaVersion: 'dias-recommendation-object-v1',
    requestId: 'REQ-1',
    generationStatus: 'OK',
    recommendation: 'DENY',
    output: { recommendation: 'DENY', reason: 'Not assigned (GP-ASSIGN:C1@v1).' },
    error: null,
    provenance: {
      contextHash: '1'.repeat(64), claimsHash: '2'.repeat(64), justificationHash: '3'.repeat(64),
      policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64), modelVersion: 'base@rev',
    },
    ...overrides,
  };
}

function commitmentFor(value) {
  return {
    requestId: value.requestId,
    recommendation: value.recommendation,
    generationStatus: value.generationStatus,
    recommendationHash: recommendationHashOf(value),
    ...value.provenance,
  };
}

describe('recommendation integrity before review', () => {
  it('verifies an object that matches its commitment', () => {
    const value = object();
    expect(checkRecommendationIntegrity({ commitment: commitmentFor(value), recommendationObject: value }))
      .to.deep.include({ status: 'verified', problems: [] });
  });

  it('reports a changed explanation through the digest alone', () => {
    const value = object();
    const changed = object({ output: { recommendation: 'DENY', reason: 'Something else.' } });
    const result = checkRecommendationIntegrity({ commitment: commitmentFor(value), recommendationObject: changed });
    expect(result.status).to.equal('mismatch');
    expect(result.problems).to.deep.equal(['h_M of the stored object differs from the committed recommendationHash']);
  });

  it('reports a changed value, status or binding even if the digest field were forged to match', () => {
    const value = object();
    const forged = { ...commitmentFor(value), recommendation: 'ALLOW', policyHash: '9'.repeat(64) };
    const result = checkRecommendationIntegrity({ commitment: forged, recommendationObject: value });
    expect(result.status).to.equal('mismatch');
    expect(result.problems).to.include('recommendation differs from the commitment');
    expect(result.problems).to.include('policyHash differs from the commitment');
  });

  it('distinguishes a missing commitment from a missing object', () => {
    expect(checkRecommendationIntegrity({ commitment: null, recommendationObject: object() }).status)
      .to.equal('no-commitment');
    expect(checkRecommendationIntegrity({ commitment: commitmentFor(object()), recommendationObject: null }).status)
      .to.equal('missing-object');
  });
});
