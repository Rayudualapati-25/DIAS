'use strict';

/**
 * One DIAS approval/deny workflow as a user and an auditor perform it through
 * the backend API, timed on the client side:
 *
 *   submit request -> wait for the LLM recommendation -> auditor opens the
 *   review -> auditor commits the decision that follows the recommendation.
 *
 * The auditor is automated (it follows the recommendation as soon as it is
 * ready), so these times contain no human review time. Readiness is observed through the batched preparation-status API. That route
 * makes no ledger call and writes no successful-read audit transaction. Review
 * payloads stay encrypted and are opened once through the authorized API.
 */

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
const AUDITORS = ['sp.north', 'sp.south', 'dj.north'];

/** Independent Audit district head; avoid reviewing the requester's own request. */
function auditorFor(request, user) {
  const record = request.record || RECORDS.get(request.recordId);
  const auditor = record && record.jurisdiction === 'district-south' ? 'sp.south' : 'sp.north';
  if ((user.username || request.username) === auditor) {
    if (auditor === 'sp.south') throw new Error('no alternate south-district auditor in the testbed fixtures');
    return 'dj.north';
  }
  return auditor;
}

function createClient(baseUrl) {
  const tokens = new Map();

  async function login(username) {
    if (tokens.has(username)) return tokens.get(username);
    const response = await fetch(`${baseUrl}/auth/login`, {
      signal: AbortSignal.timeout(30000), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
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
      method, signal: AbortSignal.timeout(180000),
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
    trail: (requestId, auditor) => api('GET', `/audit/request-trail/${requestId}`, auditor),
    preparationStatus: (ids, auditor) => api('GET', `/access/auditor/pending/status?ids=${ids.map(encodeURIComponent).join(',')}`, auditor),
    pending: (auditor) => api('GET', '/access/auditor/pending', auditor),
  };
}

/** Poll readiness in bounded batches, without decrypting or opening reviews. */
function createWatcher(client, intervalMs = 1000) {
  if (!client || typeof client.preparationStatus !== 'function') throw new Error('watcher requires a status API client');
  const waiting = new Map();
  let timer = null;
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const groups = new Map();
      for (const [requestId, waiter] of waiting) {
        if (now() >= waiter.deadline) {
          waiting.delete(requestId);
          waiter.reject(new Error(`recommendation ${requestId} not ready in time`));
          continue;
        }
        if (!groups.has(waiter.auditor)) groups.set(waiter.auditor, []);
        groups.get(waiter.auditor).push(requestId);
      }
      for (const [auditor, ids] of groups) {
        for (let offset = 0; offset < ids.length; offset += 50) {
          const batch = ids.slice(offset, offset + 50);
          try {
            const response = await client.preparationStatus(batch, auditor);
            if (response.status !== 200 || !Array.isArray(response.data)) {
              throw new Error(`preparation status ${response.status}: ${response.error || 'invalid response'}`);
            }
            for (const requestId of batch) {
              const waiter = waiting.get(requestId);
              if (!waiter) continue;
              if (now() >= waiter.deadline) {
                waiting.delete(requestId);
                waiter.reject(new Error(`recommendation ${requestId} not ready in time`));
                continue;
              }
              const status = response.data.find(item => item.requestId === requestId);
              if (!status || typeof status.preparing !== 'boolean') throw new Error(`missing status for ${requestId}`);
              if (!status.preparing) {
                waiting.delete(requestId);
                waiter.resolve({ observedAt: now() });
              }
            }
          } catch (error) {
            for (const requestId of batch) {
              const waiter = waiting.get(requestId);
              if (waiter) { waiting.delete(requestId); waiter.reject(error); }
            }
          }
        }
      }
    } finally {
      ticking = false;
      if (!waiting.size) { clearInterval(timer); timer = null; }
    }
  }
  return {
    wait(requestId, timeoutMs, auditor = 'sp.north') {
      return new Promise((resolve, reject) => {
        if (waiting.has(requestId)) { reject(new Error(`already watching ${requestId}`)); return; }
        waiting.set(requestId, { resolve, reject, auditor, deadline: now() + timeoutMs });
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
    const { observedAt } = await watcher.wait(row.requestId, timeoutMs, auditor);
    row.recommendationReadyMs = round(observedAt - t1);
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
    const entry = reviewed.data.request;
    row.verifiedRequestHash = entry.verifiedRequestHash;
    row.plannedFactsMatch = entry.verifiedRequestHash === request.verifiedRequestHash;
    const reference = referenceFor(entry.verifiedRequest);
    row.expected = reference.recommendation;
    row.expectedReasonCode = reference.reasonCode;
    row.recommendationState = reviewed.data.recommendationState;
    row.integrityStatus = reviewed.data.integrity && reviewed.data.integrity.status;
    if (reviewed.data.commitment && row.integrityStatus !== 'verified') {
      throw new Error(`recommendation integrity: ${row.integrityStatus}`);
    }
    const recommendation = reviewed.data.recommendation || {};
    row.generationStatus = recommendation.generationStatus || null;
    row.recommendation = recommendation.recommendation || null;
    row.reasonCode = recommendation.reasonCode || null;
    row.policyRefs = recommendation.policyRefs || [];
    row.modelLatencyMs = recommendation.provenance ? recommendation.provenance.latencyMs : null;
    row.adapterHash = recommendation.provenance ? recommendation.provenance.adapterHash : null;
    row.modelId = recommendation.provenance ? recommendation.provenance.modelId : null;
    row.promptVersion = recommendation.provenance ? recommendation.provenance.promptVersion : null;
    if (extra.phase === 'smoke') row.modelProvenance = recommendation.provenance || null;
    const valid = row.recommendationState === 'committed' && row.integrityStatus === 'verified' && row.generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(row.recommendation);
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
