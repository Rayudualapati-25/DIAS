'use strict';

/**
 * One DIAS approval/deny workflow as a user and an auditor perform it through
 * the backend API, timed on the client side:
 *
 *   submit request -> wait for the LLM recommendation -> auditor opens the
 *   review -> auditor commits the decision that follows the recommendation.
 *
 * The auditor is automated (it follows the recommendation as soon as it is
 * ready), so these times contain no human review time. Readiness is observed in
 * the backend's off-chain review store, which is mounted read-only; polling the
 * API instead would add one ledger audit write per poll.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const APP = path.resolve(__dirname, '..', '..');
const { loadBundle } = require(path.join(APP, 'policies/lib/bundle'));
const { evaluateReference } = require(path.join(APP, 'policies/reference-oracle/referencePolicyOracle'));
const world = require('../seed/world');

const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (value == null ? null : Math.round(value * 1000) / 1000);

const { bundle } = loadBundle(path.join(APP, 'policies/dias-governance-policy-v1.json'));
const RECORDS = new Map(world.RECORDS.map((record) => [record.recordId, record]));
const DEPARTMENT_HEAD = Object.freeze({
  police: 'sp.north', forensics: 'cfo.north', prosecution: 'dp.north', court: 'dj.north',
});
const AUDITORS = ['sp.north', 'sp.south', 'cfo.north', 'dp.north', 'dj.north'];

/** The district head of the requester's department; south-district files go to the south SP. */
function auditorFor(request, user) {
  const record = RECORDS.get(request.recordId);
  if (record && record.jurisdiction === 'district-south') return 'sp.south';
  return DEPARTMENT_HEAD[user.org];
}

function createClient(baseUrl) {
  const tokens = new Map();

  async function login(username) {
    if (tokens.has(username)) return tokens.get(username);
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`login ${username}: ${response.status} ${json.error}`);
    tokens.set(username, json.data.token);
    return json.data.token;
  }

  async function api(method, route, username, body) {
    const token = await login(username);
    const startedAt = now();
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, data: json.data, error: json.error, startedAt, ms: now() - startedAt };
  }

  return {
    login,
    submit: (username, spec) => api('POST', '/access/request', username, spec),
    review: (requestId, auditor) => api('GET', `/access/auditor/${requestId}`, auditor),
    decide: (requestId, auditor, body) => api('POST', `/access/auditor/${requestId}/decision`, auditor, body),
    readRequest: (requestId, username) => api('GET', `/access/request/${requestId}`, username),
    pending: (auditor) => api('GET', '/access/auditor/pending', auditor),
  };
}

/** Watches the review store for recommendations that become ready. */
function createWatcher(reviewDir, intervalMs = 100) {
  const waiting = new Map();
  let timer = null;

  function tick() {
    for (const [requestId, waiter] of waiting) {
      let entry = null;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(reviewDir, `${requestId}.json`), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          waiting.delete(requestId);
          waiter.reject(error);
          continue;
        }
      }
      if (entry && entry.recommendationState === 'ready') {
        waiting.delete(requestId);
        waiter.resolve({ entry, observedAt: now() });
      } else if (now() > waiter.deadline) {
        waiting.delete(requestId);
        waiter.reject(new Error(`recommendation ${requestId} not ready in time`));
      }
    }
    if (waiting.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    wait(requestId, timeoutMs) {
      return new Promise((resolve, reject) => {
        waiting.set(requestId, { resolve, reject, deadline: now() + timeoutMs });
        if (!timer) timer = setInterval(tick, intervalMs);
      });
    },
  };
}

/** The written policy's answer for the facts the ledger actually committed. */
function referenceFor(verifiedRequest) {
  const result = evaluateReference(bundle, verifiedRequest);
  return { recommendation: result.recommendation, reasonCode: result.reason_code };
}

/**
 * Run one workflow. Never throws: a failure is returned as a row with
 * status 'failed' and the stage it failed in, so a run always accounts for
 * every planned request.
 */
async function runWorkflow({
  client, watcher, request, user, timeoutMs, extra = {}, auditorListsPending = false, requesterReadsBack = false,
}) {
  const auditor = auditorFor(request, user);
  const row = {
    id: request.id, slot: request.slot, username: request.username, profile: request.profile,
    recordId: request.recordId, action: request.action, purpose: request.purpose,
    plannedExpected: request.expected, plannedReasonCode: request.expectedReasonCode,
    auditor, ...extra, status: 'failed', stage: 'submit',
  };
  const t0 = now();
  row.startedAt = round(t0);
  try {
    const submitted = await client.submit(request.username, {
      recordId: request.recordId, action: request.action, purpose: request.purpose,
      justification: request.justification,
    });
    const t1 = now();
    row.submitStatus = submitted.status;
    row.submitMs = round(t1 - t0);
    if (submitted.status !== 202 || !submitted.data || !submitted.data.requestId) {
      row.error = `submit ${submitted.status}: ${submitted.error || JSON.stringify(submitted.data)}`;
      return row;
    }
    row.requestId = submitted.data.requestId;

    row.stage = 'recommendation';
    const { entry, observedAt } = await watcher.wait(row.requestId, timeoutMs);
    row.recommendationReadyMs = round(observedAt - t1);
    row.verifiedRequestHash = entry.verifiedRequestHash;
    row.plannedFactsMatch = entry.verifiedRequestHash === request.verifiedRequestHash;
    const reference = referenceFor(entry.verifiedRequest);
    row.expected = reference.recommendation;
    row.expectedReasonCode = reference.reasonCode;

    row.stage = 'review';
    if (auditorListsPending) {
      const pending = await client.pending(auditor);
      row.pendingListStatus = pending.status;
      row.pendingListMs = round(pending.ms);
    }
    const reviewed = await client.review(row.requestId, auditor);
    const t3 = now();
    row.reviewStatus = reviewed.status;
    row.reviewMs = round(reviewed.ms);
    if (reviewed.status !== 200) {
      row.error = `review ${reviewed.status}: ${reviewed.error}`;
      return row;
    }
    const recommendation = reviewed.data.recommendation || {};
    row.generationStatus = recommendation.generationStatus || null;
    row.recommendation = recommendation.recommendation || null;
    row.reasonCode = recommendation.reasonCode || null;
    row.policyRefs = recommendation.policyRefs || [];
    row.modelLatencyMs = recommendation.provenance ? recommendation.provenance.latencyMs : null;
    row.adapterHash = recommendation.provenance ? recommendation.provenance.adapterHash : null;
    const valid = row.generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(row.recommendation);
    row.validRecommendation = valid;
    row.correct = valid ? row.recommendation === row.expected : false;
    row.reasonCorrect = valid ? row.reasonCode === row.expectedReasonCode : false;

    row.stage = 'decision';
    const body = valid
      ? { decision: row.recommendation === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY' }
      : { decision: 'FORCE_DENY', reason: 'No valid LLM recommendation was available; denied pending manual review.' };
    const decided = await client.decide(row.requestId, auditor, body);
    const t4 = now();
    row.decisionStatus = decided.status;
    row.decisionMs = round(decided.ms);
    row.decisionWaitMs = round(t3 - observedAt);
    if (decided.status !== 201) {
      row.error = `decision ${decided.status}: ${decided.error}`;
      return row;
    }
    const auditorDecision = decided.data.auditorDecision || {};
    row.decision = body.decision;
    row.ledgerRecommendation = auditorDecision.llmRecommendation || null;
    row.ledgerAgreement = auditorDecision.llmAgreement || null;
    row.decisionTxId = auditorDecision.txId || null;
    row.endToEndMs = round(t4 - t0);
    row.finishedAt = round(t4);
    if (requesterReadsBack) {
      const readBack = await client.readRequest(row.requestId, request.username);
      row.readBackStatus = readBack.status;
      row.readBackMs = round(readBack.ms);
      row.readBackOutcome = readBack.data ? readBack.data.status : null;
    }
    row.status = 'completed';
    row.stage = 'done';
    return row;
  } catch (error) {
    row.error = String(error.message || error);
    row.failedAt = round(now());
    return row;
  }
}

module.exports = {
  AUDITORS, auditorFor, createClient, createWatcher, referenceFor, round, runWorkflow, now, sleep,
};
