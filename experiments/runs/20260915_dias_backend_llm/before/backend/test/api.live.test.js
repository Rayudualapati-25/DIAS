'use strict';

/**
 * Live DIAS API integration tests.
 *
 * These require a running stack — Fabric with `diasrecords`, the recommendation
 * listener, a model server, and the API on port 3001 — so they are NOT part of
 * the default unit suite. A missing service must produce a clear precondition
 * failure rather than a confusing fetch error, which is what `before` checks.
 *
 *   CHAINCODE=diasrecords node backend/src/server.js
 *   cd backend && npm run test:live
 *
 * The suite exercises the HTTP layer specifically: the chaincode-level
 * behaviour is covered by the live Fabric scenarios, and repeating it here would
 * make this slow without making it more convincing.
 */

const { expect } = require('chai');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const RUN = Date.now();
const CASE_ID = 'CASE-2026-001';
const RECORD_ID = 'REC-FIR-001';

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
    throw new Error(
      `PRECONDITION: the API is not reachable at ${BASE}. Start it with `
      + `"CHAINCODE=diasrecords node backend/src/server.js". (${error.message})`
    );
  }
  return { status: response.status, json: await response.json() };
}

async function login(username) {
  const result = await api('POST', '/auth/login', { body: { username } });
  expect(result.json.success, `login ${username}: ${result.json.error}`).to.equal(true);
  return result.json.data.token;
}

const submit = (token, body) => api('POST', '/access/request', { token, body });

/** Poll until the listener has answered, so a slow model is not a failure. */
async function awaitAuditor(token, requestId, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await api('GET', `/access/request/${requestId}`, { token });
    const status = stored.json.data.status;
    if (status !== 'awaiting-recommendation') return stored.json.data;
    if (Date.now() > deadline) {
      throw new Error(
        `PRECONDITION: ${requestId} was never answered. Is the listener running? `
        + '"CHAINCODE=diasrecords DIAS_MODEL_URL=... node backend/src/ai/start.js"'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

describe('DIAS API (live network)', function () {
  this.timeout(600000);

  const tokens = {};

  before(async () => {
    const health = await api('GET', '/health');
    expect(health.json.data, 'the API answered but is not healthy').to.equal('ok');
    for (const user of ['insp.sharma', 'insp.singh', 'sp.north', 'dj.north', 'const.verma']) {
      tokens[user] = await login(user);
    }
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

    it('refuses an unauthenticated request', async () => {
      const result = await api('GET', '/access/auditor/pending');
      expect(result.status).to.equal(401);
    });

    it('commits a request and reaches the auditor with a recorded recommendation', async () => {
      const submitted = await submit(tokens['insp.sharma'], {
        recordId: RECORD_ID, action: 'view', purpose: 'investigation',
        justification: `API integration run ${RUN}: reading the FIR for my assigned case.`,
      });
      expect([201, 202]).to.include(submitted.status);
      const request = submitted.json.data;
      expect(request.requestId).to.match(/^REQ-/);

      const settled = await awaitAuditor(tokens['insp.sharma'], request.requestId);
      expect(['awaiting-auditor', 'granted', 'denied']).to.include(settled.status);

      // The API must never present a recommendation as an outcome. The field
      // is always present on the record; what matters is that it is still null.
      if (settled.status === 'awaiting-auditor') {
        expect(settled.outcomeId, 'a pending request must carry no outcome').to.equal(null);
      }
    });
  });

  describe('auditor routes', () => {
    let pendingRequestId;

    before(async () => {
      const submitted = await submit(tokens['insp.singh'], {
        recordId: RECORD_ID, action: 'view', purpose: 'investigation',
        justification: `API integration run ${RUN}: cross-district enquiry.`,
      });
      const request = submitted.json.data;
      if (request.status === 'granted') return; // an authorization matched; nothing pending
      const settled = await awaitAuditor(tokens['insp.singh'], request.requestId);
      if (settled.status === 'awaiting-auditor') pendingRequestId = request.requestId;
    });

    it('refuses the auditor queue to a non-auditor role', async () => {
      const result = await api('GET', '/access/auditor/pending', { token: tokens['const.verma'] });
      expect(result.status).to.equal(403);
    });

    it('serves the auditor queue to a district head', async () => {
      const result = await api('GET', '/access/auditor/pending', { token: tokens['sp.north'] });
      expect(result.status).to.equal(200);
      expect(result.json.data).to.be.an('array');
    });

    it('serves a review with the verified facts and the untrusted justification', async function () {
      if (!pendingRequestId) this.skip();
      const result = await api('GET', `/access/auditor/${pendingRequestId}`,
        { token: tokens['sp.north'] });
      expect(result.status).to.equal(200);
      const review = result.json.data;
      expect(review.request.verifiedRequest.requester).to.have.property('clearance');
      expect(review.request.verifiedRequest.resource).to.have.property('sealed');
      expect(review.request.verifiedRequest.request).to.have.property('action');
      expect(review.justification).to.be.a('string');
      expect(review.justificationHashVerified).to.equal(true);
    });

    it('rejects an auditor decision outside FORCE_ALLOW / FORCE_DENY', async function () {
      if (!pendingRequestId) this.skip();
      const result = await api('POST', `/access/auditor/${pendingRequestId}/decision`, {
        token: tokens['sp.north'], body: { decision: 'maybe' },
      });
      expect(result.status).to.equal(400);
    });

    it('records a final decision and reports whether an authorization was created', async function () {
      if (!pendingRequestId) this.skip();
      const result = await api('POST', `/access/auditor/${pendingRequestId}/decision`, {
        token: tokens['sp.north'],
        body: { decision: 'FORCE_DENY', reason: `API integration run ${RUN}` },
      });
      expect(result.status).to.equal(201);
      const data = result.json.data;
      expect(data.accessOutcome.outcome).to.equal('DENIED');
      // FORCE_DENY never creates one, whatever the model said.
      expect(data.dynamicAuthorization).to.equal(null);
    });
  });

  describe('dynamic authorization routes', () => {
    it('lists authorizations for an auditor and refuses a non-auditor', async () => {
      const allowed = await api('GET', '/access/dynamic-authorizations?status=all',
        { token: tokens['sp.north'] });
      expect(allowed.status).to.equal(200);
      expect(allowed.json.data).to.be.an('array');

      const refused = await api('GET', '/access/dynamic-authorizations',
        { token: tokens['const.verma'] });
      expect(refused.status).to.equal(403);
    });

    it('requires a reason to revoke', async () => {
      const list = await api('GET', '/access/dynamic-authorizations?status=all',
        { token: tokens['sp.north'] });
      const [first] = list.json.data;
      if (!first) return;
      const result = await api('POST',
        `/access/dynamic-authorizations/${first.authorizationId}/revoke`,
        { token: tokens['sp.north'], body: {} });
      expect(result.status).to.equal(400);
    });

    it('serves authorization history with its lifecycle events', async () => {
      const list = await api('GET', '/access/dynamic-authorizations?status=all',
        { token: tokens['sp.north'] });
      const [first] = list.json.data;
      if (!first) return;
      const result = await api('GET',
        `/access/dynamic-authorizations/${first.authorizationId}/history`,
        { token: tokens['sp.north'] });
      expect(result.status).to.equal(200);
      expect(result.json.data.history).to.be.an('array');
      expect(result.json.data.events).to.be.an('array');
    });
  });

  describe('audit trail routes', () => {
    let requestId;

    before(async () => {
      const queue = await api('GET', '/access/auditor/pending', { token: tokens['sp.north'] });
      requestId = queue.json.data?.[0]?.request?.requestId;
      if (!requestId) {
        const submitted = await submit(tokens['insp.sharma'], {
          recordId: RECORD_ID, action: 'view', purpose: 'investigation',
          justification: `API integration run ${RUN}: trail fixture.`,
        });
        requestId = submitted.json.data.requestId;
        await awaitAuditor(tokens['insp.sharma'], requestId);
      }
    });

    it('reconstructs a request lifecycle for a reviewer', async () => {
      const result = await api('GET', `/audit/request-trail/${requestId}`,
        { token: tokens['sp.north'] });
      expect(result.status).to.equal(200);
      const trail = result.json.data;
      expect(trail.lifecycle).to.be.an('array').that.is.not.empty;
      expect(trail.lifecycle[0].eventType).to.equal('ACCESS_REQUEST_SUBMITTED');
      expect(trail.transactions).to.be.an('array');
      expect(trail.privateText.visibility).to.equal('reviewer');
      expect(trail.provenanceSource).to.match(/Hyperledger Fabric/);
    });

    it('gives the requester their own trail with hash checks but no private text', async () => {
      const result = await api('GET', `/access/request/${requestId}/trail`,
        { token: tokens['insp.sharma'] });
      if (result.status === 403) return; // a different requester owns it
      expect(result.status).to.equal(200);
      expect(result.json.data.privateText.visibility).to.match(/requester/);
      expect(result.json.data.privateText.justification).to.equal(null);
    });

    it('refuses a request trail to an unrelated non-reviewer', async () => {
      const result = await api('GET', `/audit/request-trail/${requestId}`,
        { token: tokens['const.verma'] });
      // 403 when the API's own role guard catches it, 422 when the refusal comes
      // back from the chaincode. Both are refusals; a 200 would be the defect.
      expect([403, 422], `unexpected status ${result.status}`).to.include(result.status);
      expect(result.json.success).to.equal(false);
      expect(result.json.error).to.match(/unauthorized|requires a reviewer/i);
    });
  });

  describe('the API never presents a recommendation as a decision', () => {
    it('an awaiting-auditor request carries no access outcome', async () => {
      const queue = await api('GET', '/access/auditor/pending', { token: tokens['sp.north'] });
      for (const review of queue.json.data || []) {
        expect(review.request.status).to.equal('awaiting-auditor');
        expect(review.request.outcomeId, 'a pending request must have no outcome').to.equal(null);
        if (review.recommendation) {
          expect(['ALLOW', 'DENY', null]).to.include(review.recommendation.recommendation);
          expect(review.recommendation.terminology).to.match(/advisory/i);
        }
      }
    });
  });
});
