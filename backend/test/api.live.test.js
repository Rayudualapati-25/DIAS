'use strict';

/**
 * Live DIAS API integration tests.
 *
 * These need a running stack — Fabric with `diasrecords` on `diaschannel`, the
 * model server, and the API on port 3001 — so they are NOT part of the default
 * unit suite. A missing service produces a named precondition failure rather
 * than a confusing fetch error.
 *
 *   make dias-model      # terminal 1
 *   make dias-backend    # terminal 2
 *   make smoke           # this suite
 *
 * The suite exercises the HTTP layer of the current design: the request log, the
 * LLM recommendation kept in the backend, the auditor decision log with its LLM
 * agreement, the audit trail, and the public case-file lookup. The full scenario
 * matrix (every agreement combination, reuse, revocation, expiry) is the live
 * acceptance run, `make dias-acceptance`.
 *
 * Every decision this suite records is FORCE_DENY, so it never creates a dynamic
 * authorization and can be run repeatedly against the same ledger.
 */

const { expect } = require('chai');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const RUN = Date.now();
const RECORD_ID = 'REC-FIR-001';
const RECOMMENDATION_TIMEOUT_MS = Number(process.env.DIAS_LIVE_RECOMMENDATION_TIMEOUT_MS || 240000);
const LLM_FIELDS = /"(recommendation\w*|reasonCode|policyRefs|reviewFlags|missingEvidence|justification\w*)"\s*:/;

async function api(method, route, { token, body } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new Error(`PRECONDITION: the API is not reachable at ${BASE}. Start it with `
      + `"make dias-backend". (${error.message})`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { success: false, error: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

async function login(username) {
  const result = await api('POST', '/auth/login', { body: { username } });
  expect(result.json.success, `login ${username}: ${result.json.error}`).to.equal(true);
  return result.json.data.token;
}

const submit = (token, body) => api('POST', '/access/request', { token, body });

/** Wait until the backend has stored the LLM recommendation, or its failure. */
async function awaitRecommendation(token, requestId) {
  const deadline = Date.now() + RECOMMENDATION_TIMEOUT_MS;
  for (;;) {
    const review = await api('GET', `/access/auditor/${requestId}`, { token });
    expect(review.status, review.json.error).to.equal(200);
    if (review.json.data.recommendationState !== 'pending') return review.json.data;
    if (Date.now() > deadline) {
      throw new Error(`PRECONDITION: no recommendation for ${requestId} within `
        + `${RECOMMENDATION_TIMEOUT_MS} ms. Is the model server running? "make dias-model"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The agreement value the ledger must hold for a FORCE_DENY after this recommendation. */
function expectedAgreementForDeny(recommendation) {
  if (!recommendation || recommendation.generationStatus !== 'OK') return 'NO_RECOMMENDATION';
  return recommendation.recommendation === 'DENY' ? 'AGREED' : 'NOT_AGREED';
}

describe('DIAS API (live network)', function () {
  this.timeout(600000);

  const tokens = {};

  before(async () => {
    const health = await api('GET', '/health');
    expect(health.json.data, 'the API answered but is not healthy').to.equal('ok');
    for (const user of ['insp.sharma', 'insp.singh', 'const.verma', 'sp.north', 'judge.rana']) {
      tokens[user] = await login(user);
    }
    const demoData = await api('GET', `/records/lookup/${RECORD_ID}`, { token: tokens['insp.sharma'] });
    expect(demoData.status,
      `PRECONDITION: ${RECORD_ID} is missing. Run "make dias-demo-data" and try again.`).to.equal(200);
  });

  describe('request submission', () => {
    it('rejects an action outside the policy vocabulary', async () => {
      const result = await submit(tokens['insp.sharma'], {
        recordId: RECORD_ID, action: 'delete', purpose: 'investigation',
        justification: 'Testing the vocabulary boundary.',
      });
      expect(result.status).to.equal(400);
      expect(result.json.success).to.equal(false);
    });

    it('rejects a request with no justification', async () => {
      const result = await submit(tokens['insp.sharma'], {
        recordId: RECORD_ID, action: 'view', purpose: 'investigation',
      });
      expect(result.status).to.equal(400);
    });

    it('refuses an unauthenticated caller', async () => {
      const result = await api('GET', '/access/auditor/pending');
      expect(result.status).to.equal(401);
    });

    it('finds a case file from another station through the public index', async () => {
      const result = await api('GET', `/records/lookup/${RECORD_ID}`, { token: tokens['insp.singh'] });
      expect(result.status, result.json.error).to.equal(200);
      expect(result.json.data).to.deep.equal({
        recordId: RECORD_ID,
        caseId: result.json.data.caseId,
        owningMsp: result.json.data.owningMsp,
        owningAgency: result.json.data.owningAgency,
        owningStation: result.json.data.owningStation,
      });
      expect(result.json.data).to.not.have.property('offChainReference');
      const missing = await api('GET', '/records/lookup/REC-DOES-NOT-EXIST', { token: tokens['insp.singh'] });
      expect(missing.status).to.equal(404);
    });
  });

  describe('request log, backend recommendation and decision log', () => {
    let requestId;
    let review;
    let decided;

    before(async () => {
      const submitted = await submit(tokens['insp.sharma'], {
        recordId: RECORD_ID, action: 'annotate', purpose: 'investigation',
        justification: `API integration run ${RUN}: annotating the FIR for my assigned case.`,
      });
      expect([201, 202], submitted.json.error).to.include(submitted.status);
      requestId = submitted.json.data.requestId;
      if (submitted.status === 202) review = await awaitRecommendation(tokens['sp.north'], requestId);
    });

    it('commits who requested which record, without the justification', async function () {
      const stored = await api('GET', `/access/request/${requestId}`, { token: tokens['insp.sharma'] });
      expect(stored.status).to.equal(200);
      expect(stored.json.data.requester.username).to.equal('insp.sharma');
      expect(stored.json.data).to.include({ recordId: RECORD_ID, action: 'annotate', purpose: 'investigation' });
      expect(JSON.stringify(stored.json.data)).to.not.match(LLM_FIELDS);
      if (!review) this.skip();
    });

    it('shows the auditor the justification and the recommendation kept in the backend', function () {
      if (!review) this.skip();
      expect(review.request.requestId).to.equal(requestId);
      expect(review.request.verifiedRequest.requester).to.have.property('clearance');
      expect(review.justification).to.match(new RegExp(String(RUN)));
      expect(review.recommendationState).to.equal('ready');
      expect(['OK', 'UNAVAILABLE', 'INVALID_OUTPUT', 'POLICY_CONTEXT_UNAVAILABLE', 'CONTEXT_OVERFLOW'])
        .to.include(review.recommendation.generationStatus);
      if (review.recommendation.generationStatus === 'OK') {
        expect(['ALLOW', 'DENY']).to.include(review.recommendation.recommendation);
      }
    });

    it('keeps a pending request free of any access outcome', async function () {
      if (!review) this.skip();
      const queue = await api('GET', '/access/auditor/pending', { token: tokens['sp.north'] });
      const item = queue.json.data.find((entry) => entry.request.requestId === requestId);
      expect(item, 'the request is in the auditor queue').to.not.equal(undefined);
      expect(item.request.status).to.equal('awaiting-auditor');
      expect(item.request.outcomeId).to.equal(null);
    });

    it('refuses the queue to a non-auditor and an unknown decision to an auditor', async function () {
      const refused = await api('GET', '/access/auditor/pending', { token: tokens['const.verma'] });
      expect(refused.status).to.equal(403);
      if (!review) this.skip();
      const invalid = await api('POST', `/access/auditor/${requestId}/decision`, {
        token: tokens['sp.north'], body: { decision: 'maybe' },
      });
      expect(invalid.status).to.equal(400);
    });

    it('commits the auditor decision with the LLM agreement the backend derived', async function () {
      if (!review) this.skip();
      decided = await api('POST', `/access/auditor/${requestId}/decision`, {
        token: tokens['sp.north'],
        // A browser-supplied agreement must be ignored.
        body: { decision: 'FORCE_DENY', reason: `API integration run ${RUN}`, llmAgreement: 'AGREED' },
      });
      expect(decided.status, decided.json.error).to.equal(201);
      const data = decided.json.data;
      expect(data.accessOutcome.outcome).to.equal('DENIED');
      expect(data.dynamicAuthorization).to.equal(null);
      expect(data.auditorDecision.llmAgreement).to.equal(expectedAgreementForDeny(review.recommendation));
      expect(JSON.stringify(data)).to.not.match(LLM_FIELDS);
    });

    it('reconstructs both logs for a reviewer, with the off-chain review kept separate', async function () {
      if (!decided) this.skip();
      const trail = await api('GET', `/audit/request-trail/${requestId}`, { token: tokens['sp.north'] });
      expect(trail.status).to.equal(200);
      const { lifecycle, auditorDecision, offChainReview, request, provenanceSource } = trail.json.data;
      expect(lifecycle[0].eventType).to.equal('ACCESS_REQUEST_SUBMITTED');
      expect(lifecycle.map((event) => event.eventType)).to.include('AUDITOR_DECISION_RECORDED');
      expect(auditorDecision.decision).to.equal('FORCE_DENY');
      expect(provenanceSource).to.match(/Hyperledger Fabric/);
      expect(JSON.stringify({ request, lifecycle, auditorDecision })).to.not.match(LLM_FIELDS);
      expect(offChainReview.storage).to.match(/not on the ledger/);
      expect(offChainReview.auditorNote.reason).to.equal(`API integration run ${RUN}`);
    });

    it('gives the requester their own trail without the off-chain review', async function () {
      if (!decided) this.skip();
      const trail = await api('GET', `/access/request/${requestId}/trail`, { token: tokens['insp.sharma'] });
      expect(trail.status).to.equal(200);
      expect(trail.json.data.viewer).to.equal('requester');
      expect(trail.json.data).to.not.have.property('offChainReview');
    });

    it('refuses the trail to an unrelated non-reviewer', async function () {
      if (!decided) this.skip();
      const result = await api('GET', `/audit/request-trail/${requestId}`, { token: tokens['const.verma'] });
      expect([403, 422], `unexpected status ${result.status}`).to.include(result.status);
      expect(result.json.error).to.match(/unauthorized|requires a reviewer/i);
    });

    it('records the outcome as decided by the auditor', async function () {
      if (!decided) this.skip();
      const stored = await api('GET', `/access/request/${requestId}`, { token: tokens['insp.sharma'] });
      expect(stored.json.data.status).to.equal('denied');
      const decision = await api('GET', `/access/decision/${RECORD_ID}/${stored.json.data.outcomeId}`,
        { token: tokens['insp.sharma'] });
      expect(decision.status).to.equal(200);
      expect(decision.json.data).to.include({ decisionAuthority: 'auditor', status: 'denied' });
    });
  });

  describe('dynamic authorization routes', () => {
    it('lists authorizations for an auditor and refuses a non-auditor', async () => {
      const allowed = await api('GET', '/access/dynamic-authorizations?status=all', { token: tokens['sp.north'] });
      expect(allowed.status).to.equal(200);
      expect(allowed.json.data).to.be.an('array');
      const refused = await api('GET', '/access/dynamic-authorizations', { token: tokens['const.verma'] });
      expect(refused.status).to.equal(403);
    });

    it('requires a reason to revoke and serves history with lifecycle events', async function () {
      const list = await api('GET', '/access/dynamic-authorizations?status=all', { token: tokens['sp.north'] });
      const [first] = list.json.data;
      if (!first) this.skip();
      const revoke = await api('POST', `/access/dynamic-authorizations/${first.authorizationId}/revoke`,
        { token: tokens['sp.north'], body: {} });
      expect(revoke.status).to.equal(400);
      const history = await api('GET', `/access/dynamic-authorizations/${first.authorizationId}/history`,
        { token: tokens['sp.north'] });
      expect(history.status).to.equal(200);
      expect(history.json.data.history).to.be.an('array');
      expect(history.json.data.events).to.be.an('array');
    });
  });

  describe('retired endpoints', () => {
    it('no longer serves the SEAL explanation or LLM-request routes', async () => {
      const explain = await api('POST', `/explain/${RECORD_ID}/OUTCOME-1`, { token: tokens['insp.sharma'] });
      const llmRequest = await api('POST', '/access/llm-request', { token: tokens['insp.sharma'], body: {} });
      expect(explain.status).to.equal(404);
      expect(llmRequest.status).to.equal(404);
    });
  });
});
