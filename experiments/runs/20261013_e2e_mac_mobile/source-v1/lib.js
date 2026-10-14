'use strict';

/**
 * Shared pieces of the end-to-end experiment: a timed API client that calls the
 * backend exactly as the web portal does, the automated auditor's rule, the
 * ledger checks made on every finished workflow, and the statistics.
 *
 * The reference policy oracle is used here only after the fact, on the verified
 * facts the ledger committed, to say whether the LLM's advice matched the written
 * policy. It is never part of the running application.
 */

const path = require('path');
const { performance } = require('perf_hooks');

const APP = path.resolve(__dirname, '..', '..');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => (value == null ? null : Math.round(value * 10) / 10);

function createClient(baseUrl) {
  const tokens = new Map();

  async function login(username) {
    if (tokens.has(username)) return tokens.get(username);
    const response = await fetch(`${baseUrl}/auth/login`, {
      signal: AbortSignal.timeout(30000), method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`sign-in ${username}: ${response.status} ${json.error}`);
    tokens.set(username, json.data.token);
    return json.data.token;
  }

  /** One call, timed from just before it is sent to when its body is read. */
  async function api(method, route, username, body) {
    const token = await login(username);
    const startedAt = now();
    const response = await fetch(`${baseUrl}${route}`, {
      method, signal: AbortSignal.timeout(180000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, data: json.data, error: json.error, ms: now() - startedAt };
  }

  return {
    login,
    get: (route, username) => api('GET', route, username),
    post: (route, username, body) => api('POST', route, username, body),
  };
}

/**
 * Wait until the backend has produced, signed and committed the recommendation.
 * The status route reads only the backend's review store: no ledger call and no
 * access-log entry, so polling it does not disturb what is being measured.
 */
async function waitForRecommendation(client, requestId, auditor, { timeoutMs = 300000, pollMs = 200 } = {}) {
  const startedAt = now();
  for (;;) {
    const status = await client.get(`/access/auditor/pending/status?ids=${encodeURIComponent(requestId)}`, auditor);
    const entry = Array.isArray(status.data) ? status.data.find((item) => item.requestId === requestId) : null;
    if (status.status !== 200 || !entry) throw new Error(`preparation status: ${status.status} ${status.error || 'no entry'}`);
    if (!entry.preparing) return now() - startedAt;
    if (now() - startedAt > timeoutMs) throw new Error(`no recommendation within ${timeoutMs} ms`);
    await sleep(pollMs);
  }
}

/**
 * What the automated auditor does: it follows the recommendation, and only one
 * that was committed, verified against its commitment and produced successfully.
 * Anything else is denied with a reason, as a careful auditor would.
 */
function adviceDecision({ recommendationState, integrity, generationStatus, recommendation }) {
  const usable = recommendationState === 'committed' && integrity === 'verified'
    && generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(recommendation);
  if (usable) return { decision: recommendation === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY', followed: true };
  return {
    decision: 'FORCE_DENY', followed: false,
    reason: 'No committed and verified LLM recommendation was available; denied pending manual review.',
  };
}

const REVIEWED_STAGES = Object.freeze([
  'ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'RECOMMENDATION_COMMITTED',
  'AUDITOR_DECISION_RECORDED', 'AGREEMENT_DERIVED', 'ACCESS_OUTCOME_RECORDED',
]);
const DECISION_STAGES = REVIEWED_STAGES.slice(3);

/** The agreement the contract must have derived from the committed recommendation. */
function agreementFor(commitment, decision) {
  const usable = commitment && commitment.generationStatus === 'OK'
    && ['ALLOW', 'DENY'].includes(commitment.recommendation);
  if (!usable) return { llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION' };
  const agreed = (decision === 'FORCE_ALLOW') === (commitment.recommendation === 'ALLOW');
  return { llmRecommendation: commitment.recommendation, llmAgreement: agreed ? 'AGREED' : 'NOT_AGREED' };
}

/**
 * The ledger checks on one reviewed workflow, read from its trail. `expected` is
 * what the auditor sent and was shown: { requestId, decision, auditor, outcomeId }.
 */
function checkTrail(trail, expected) {
  const lifecycle = trail.lifecycle || [];
  const decision = trail.auditorDecision || {};
  const outcome = trail.accessOutcome || {};
  const commitment = trail.recommendationCommitment || null;
  const verification = trail.offChainVerification || {};
  const stages = lifecycle.map((event) => event.eventType);
  const wanted = commitment ? REVIEWED_STAGES : REVIEWED_STAGES.filter((stage) => stage !== 'RECOMMENDATION_COMMITTED');
  const ordered = lifecycle.every((event, index) => index === 0
    || (event.seq > lifecycle[index - 1].seq && String(event.timestamp) >= String(lifecycle[index - 1].timestamp)));
  const decisionTx = lifecycle.filter((event) => DECISION_STAGES.includes(event.eventType)).map((event) => event.txId);
  const derived = agreementFor(commitment, decision.decision);
  const check = (name, ok) => ({ name, ok: Boolean(ok) });
  return [
    check('lifecycle stages are complete and in order',
      ordered && stages.length === wanted.length && stages.every((stage, index) => stage === wanted[index])),
    check('decision, agreement and outcome share one transaction',
      decisionTx.length === DECISION_STAGES.length && decisionTx.every((txId) => txId && txId === decision.txId)),
    check('the ledger holds the decision that was sent', decision.decision === expected.decision),
    check('the outcome follows from the decision',
      outcome.outcome === (decision.decision === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED')),
    check('the agreement follows from the committed recommendation',
      decision.llmAgreement === derived.llmAgreement && decision.llmRecommendation === derived.llmRecommendation),
    check('the decision is recorded under the auditor who made it',
      decision.auditor && decision.auditor.username === expected.auditor),
    check('the outcome is the one the auditor was shown', outcome.outcomeId === expected.outcomeId),
    check('off-chain justification and recommendation match their ledger digests',
      verification.justification && verification.justification.status === 'verified'
      && (!commitment || (verification.recommendation && verification.recommendation.status === 'verified'))),
    check('the request status matches the outcome',
      trail.request && String(trail.request.status).toUpperCase() === outcome.outcome),
  ];
}

/** The written policy's answer for the facts the ledger committed (offline, after the fact). */
function referenceFor(verifiedRequest) {
  const { loadBundle } = require(path.join(APP, 'policies/lib/bundle'));
  const { evaluateReference } = require(path.join(APP, 'policies/reference-oracle/referencePolicyOracle'));
  const { bundle } = loadBundle(path.join(APP, 'policies/dias-governance-policy-v1.json'));
  const result = evaluateReference(bundle, verifiedRequest);
  return { recommendation: result.recommendation, reasonCode: result.reason_code };
}

/** Nearest-rank percentile of the sorted values. */
function percentile(values, p) {
  if (values.length === 0) throw new Error('no values');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** n, min, median, mean, p95 and max of the values that were measured; null when none were. */
function summarize(values) {
  const measured = values.filter((value) => Number.isFinite(value));
  if (measured.length === 0) return null;
  return {
    n: measured.length,
    min: round(Math.min(...measured)),
    median: round(percentile(measured, 50)),
    mean: round(measured.reduce((sum, value) => sum + value, 0) / measured.length),
    p95: round(percentile(measured, 95)),
    max: round(Math.max(...measured)),
  };
}

/** The stages a workflow actively spends, from the request to the confirmed decision. */
const PROCESSING_STAGES = Object.freeze([
  'submitMs', 'recommendationMs', 'queueMs', 'reviewMs', 'decisionMs', 'readbackMs',
]);

/** Their sum; null when any stage was not measured, so a partial row is never averaged in. */
function endToEndMs(row) {
  const parts = PROCESSING_STAGES.map((stage) => row[stage]);
  return parts.every((value) => Number.isFinite(value)) ? round(parts.reduce((sum, value) => sum + value, 0)) : null;
}

/** The verdict of one `am instrument -w` run, read from what it printed. */
function parseInstrumentation(stdout) {
  const text = String(stdout || '');
  const passed = text.match(/^OK \((\d+) tests?\)/m);
  if (passed && Number(passed[1]) > 0) return { ok: true, tests: Number(passed[1]), detail: passed[0] };
  const cause = text.split('\n').find((line) => /AssertionError|Exception|Process crashed|shortMsg|OK \(0/.test(line));
  return { ok: false, tests: 0, detail: (cause || text.trim().split('\n').pop() || 'no output').trim() };
}

module.exports = {
  PROCESSING_STAGES, adviceDecision, agreementFor, checkTrail, createClient, endToEndMs, now,
  parseInstrumentation, percentile, referenceFor, round, sleep, summarize, waitForRecommendation,
};
