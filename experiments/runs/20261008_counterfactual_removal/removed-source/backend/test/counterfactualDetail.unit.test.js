'use strict';

const { expect } = require('chai');
const { loadBundle } = require('../../policies/lib/bundle');
const { verifiedRequestHash, VERIFIED_REQUEST_SCHEMA_VERSION } =
  require('../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { recommendationExplanation } = require('../src/routes/access');
const { committedRequest } = require('./fixtures/decisionFixtures');

const requester = { org: 'police', fabricUser: 'insp.test', role: 'inspector' };
const auditor = { org: 'audit', fabricUser: 'sp.north', role: 'sp' };
function trail(overrides = {}) {
  const request = committedRequest('REQ-1');
  request.verifiedRequestSchemaVersion = VERIFIED_REQUEST_SCHEMA_VERSION;
  request.verifiedRequest.requester.assignedToRequestedCase = false;
  request.verifiedRequestHash = verifiedRequestHash(request.verifiedRequest);
  return {
    requestId: 'REQ-1', viewer: 'requester', isRequester: true, request,
    summary: { auditor: { decision: 'FORCE_DENY', llmRecommendation: 'DENY', username: 'sp.north', role: 'sp' },
      outcome: { outcome: 'DENIED', basis: 'AUDITOR_DECISION' } },
    ...overrides,
  };
}
async function ask(current = trail(), options = {}) {
  const calls = [];
  const entry = { recommendationState: 'committed', recommendation: {
    generationStatus: 'OK', recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED',
    reason: 'The model text stays unchanged.', policyRefs: ['GP-ASSIGN:C1@v1'],
  }, verifiedRequest: { untrusted: 'never used' } };
  const result = await recommendationExplanation({
    user: requester, requestId: 'REQ-1', enabled: true,
    ledger: { evaluate: async (...args) => { calls.push(args); return current; } },
    store: { readSafely: () => entry },
    bundleLoader: () => loadBundle().bundle,
    ...options,
  });
  return { ...result, calls };
}

describe('counterfactual API detail', () => {
  it('uses the caller-authorized ledger facts and leaves the LLM text unchanged', async () => {
    const result = await ask();
    expect(result.status).to.equal(200);
    expect(result.calls).to.deep.equal([['police', 'insp.test', 'AuditContract', 'GetRequestAuditTrail', 'REQ-1']]);
    expect(result.data.reason).to.equal('The model text stays unchanged.');
    expect(result.data.counterfactuals.available).to.equal(true);
    expect(result.data.counterfactuals.changeSets[0].changes[0].fact).to.equal('requester.assignedToRequestedCase');
  });

  it('loads no policy for waiting, allowed or automatically settled requester views', async () => {
    for (const summary of [
      { auditor: { status: 'PENDING' }, outcome: null },
      { auditor: { decision: 'FORCE_ALLOW', llmRecommendation: 'ALLOW' }, outcome: { outcome: 'GRANTED' } },
      { auditor: { status: 'SKIPPED' }, outcome: { outcome: 'GRANTED', basis: 'DYNAMIC_AUTHORIZATION' } },
    ]) {
      const result = await ask(trail({ summary }), { bundleLoader: () => { throw new Error('must not load'); } });
      expect(result.data.counterfactuals).to.equal(null);
    }
  });

  it('does not expose hints to another organization or to an auditor requesting their own record', async () => {
    const refused = await ask(trail({ viewer: 'reviewer', isRequester: false }), {
      user: { org: 'court', role: 'judge', fabricUser: 'judge.rana' },
      bundleLoader: () => { throw new Error('must not load'); },
    });
    expect(refused.status).to.equal(403);
    const own = await ask(trail({ viewer: 'reviewer', summary: { auditor: { status: 'PENDING' } } }), {
      user: auditor, bundleLoader: () => { throw new Error('must not load'); },
    });
    expect(own.data.counterfactuals).to.equal(null);
  });

  it('lets an auditor explain somebody else\'s waiting request, without any submit', async () => {
    const result = await ask(trail({ viewer: 'reviewer', isRequester: false, summary: { auditor: { status: 'PENDING' } } }), { user: auditor });
    expect(result.data.viewer).to.equal('auditor');
    expect(result.data.counterfactuals.available).to.equal(true);
  });

  it('can be removed entirely with the feature toggle', async () => {
    const result = await ask(trail(), { enabled: false, bundleLoader: () => { throw new Error('must not load'); } });
    expect(result.data.counterfactuals).to.equal(null);
    expect(result.data.reason).to.equal('The model text stays unchanged.');
  });

  it('suppresses a changed context or mismatching policy rather than giving an unbound explanation', async () => {
    for (const field of ['verifiedRequestHash', 'policyHash', 'policyVersion', 'verifiedRequestSchemaVersion']) {
      const current = trail(); current.request[field] = 'changed';
      const result = await ask(current);
      expect(result.data.counterfactuals.available, field).to.equal(false);
      expect(result.data.counterfactuals).to.not.have.property('changeSets');
    }
  });

  it('treats missing facts and missing policy as unavailable, without failing the LLM detail', async () => {
    const missing = await ask(trail({ request: null }));
    expect(missing.data.counterfactuals.available).to.equal(false);
    const noBundle = await ask(trail(), { bundleLoader: () => { throw new Error('missing file'); } });
    expect(noBundle.data.counterfactuals.available).to.equal(false);
    expect(noBundle.data.reason).to.equal('The model text stays unchanged.');
  });
});
