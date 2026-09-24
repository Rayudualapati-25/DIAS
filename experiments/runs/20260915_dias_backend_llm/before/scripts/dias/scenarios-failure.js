'use strict';

/**
 * Live scenarios I–O: generation failures, listener behaviour under restart and
 * concurrency, and the authority boundaries the chaincode enforces.
 *
 * Scenarios I and J need a model that fails in a specific way. Rather than
 * mocking the workflow, the harness runs the real listener path
 * (`handleRequest`) against a deliberately broken endpoint — an unreachable port
 * for I, and a local server that answers with prose for J. That is exactly the
 * operator-visible failure, and the transactions it produces are real.
 */

const http = require('http');
const fabric = require('../../backend/src/fabric/gateway');
const service = require('../../backend/src/dias/recommendationService');
const { createDiasRuntime } = require('../../backend/src/dias/runtime');
const { ACCESS, AUDITOR, OTHER_AUDITOR, check, decide, outcome, review, sleep, trail } = require('./live-scenarios');
const { CROSS_DISTRICT, run } = require('./scenarios-core');

const silent = { log() {}, error() {} };

/**
 * Answer one committed request through the real listener path.
 *
 * The timeout must exceed real inference time. An 8-second budget turned every
 * ordinary answer into an UNAVAILABLE status, which looks exactly like a broken
 * model and would have made the whole acceptance run measure the harness.
 */
async function answerWith(requestId, modelUrl, timeoutMs = 240000) {
  const runtime = createDiasRuntime({
    settings: {
      ...require('../../backend/src/config'),
      DIAS_MODEL_URL: modelUrl,
      DIAS_MODEL_TIMEOUT_MS: timeoutMs,
    },
  });
  return service.handleRequest(requestId, {
    fabric,
    recommenderFor: runtime.recommenderFor,
    signer: runtime.signer,
    policyBundleHash: runtime.policyBundleHash,
    log: silent,
  });
}

/** A server that answers every completion with prose instead of JSON. */
function startProseServer(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: 'On balance I think this one should probably be allowed.' } }],
        usage: { prompt_tokens: 1900, completion_tokens: 14 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/**
 * Submit a request while the live listener is paused, so the harness itself
 * answers it. The caller is responsible for pausing and resuming the listener.
 */
async function submitWithoutAnswer(spec, overrides = {}) {
  return fabric.submitWithTransient(
    (overrides.requester || spec.requester).org,
    (overrides.requester || spec.requester).user,
    ACCESS, 'CreateAccessRequest',
    [overrides.recordId || spec.recordId, JSON.stringify({ ...spec.body, ...(overrides.body || {}) })],
    { justification: Buffer.from(overrides.justification || spec.justification, 'utf8') },
    fabric.ACCESS_QUERY_ENDORSERS
  );
}

/** I: the model is unavailable — the auditor can still decide, but creates nothing. */
async function scenarioI(created) {
  await answerWith(created.requestId, 'http://127.0.0.1:9/v1');
  const detail = await review(created.requestId);
  const recommendation = detail.recommendation || {};
  const reason = 'Decided without a model recommendation; the request is time-critical.';
  const result = await decide(created.requestId, 'FORCE_ALLOW', reason);
  const after = await trail(created.requestId);
  return outcome('I', 'Model unavailable', 'auditor can decide; no authorization is created', [
    check('generation status is UNAVAILABLE',
      recommendation.generationStatus === 'UNAVAILABLE', recommendation.generationStatus),
    check('no recommendation was invented', recommendation.recommendation === null,
      String(recommendation.recommendation)),
    check('an error code was recorded', Boolean(recommendation.errorCode), recommendation.errorCode),
    check('the request still reached the auditor', detail.request.status === 'awaiting-auditor',
      detail.request.status),
    check('the auditor decision was accepted', result.accessOutcome.outcome === 'GRANTED',
      result.accessOutcome.outcome),
    check('an override reason was required and recorded',
      result.auditorDecision.override === true && Boolean(result.auditorDecision.reasonHash),
      `override=${result.auditorDecision.override}`),
    check('NO dynamic authorization was created', result.dynamicAuthorization === null,
      String(result.dynamicAuthorization)),
    check('lifecycle records LLM_RECOMMENDATION_UNAVAILABLE',
      after.lifecycle.some((e) => e.eventType === 'LLM_RECOMMENDATION_UNAVAILABLE'),
      after.lifecycle.map((e) => e.eventType).join(',')),
  ], {
    requestId: created.requestId,
    generationStatus: recommendation.generationStatus,
    errorCode: recommendation.errorCode,
    auditorTxId: result.auditorDecision.txId,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** J: the model answers with something that is not a recommendation. */
async function scenarioJ(created) {
  const server = await startProseServer(8099);
  try {
    await answerWith(created.requestId, 'http://127.0.0.1:8099/v1');
  } finally {
    server.close();
  }
  const detail = await review(created.requestId);
  const recommendation = detail.recommendation || {};
  const after = await trail(created.requestId);
  return outcome('J', 'Invalid model output', 'INVALID_OUTPUT recorded, request routed to the auditor', [
    check('generation status is INVALID_OUTPUT',
      recommendation.generationStatus === 'INVALID_OUTPUT', recommendation.generationStatus),
    check('no recommendation was salvaged from the prose',
      recommendation.recommendation === null, String(recommendation.recommendation)),
    check('the request is waiting for the auditor',
      detail.request.status === 'awaiting-auditor', detail.request.status),
    check('the parser failure is recorded in provenance',
      Array.isArray(recommendation.provenance?.parserErrors)
      && recommendation.provenance.parserErrors.length > 0,
      JSON.stringify(recommendation.provenance?.parserErrors || [])),
    check('the raw output hash is committed',
      /^[0-9a-f]{64}$/.test(recommendation.provenance?.rawOutputHash || ''),
      recommendation.provenance?.rawOutputHash),
  ], {
    requestId: created.requestId,
    generationStatus: recommendation.generationStatus,
    parserErrors: recommendation.provenance?.parserErrors,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** K: a request committed while the listener was down is answered after restart. */
async function scenarioK(created, modelUrl) {
  const before = await fabric.evaluate(
    AUDITOR.org, AUDITOR.user, ACCESS, 'GetRequest', created.requestId);
  const answered = await answerWith(created.requestId, modelUrl);
  const after = await fabric.evaluate(
    AUDITOR.org, AUDITOR.user, ACCESS, 'GetRequest', created.requestId);
  const audit = await trail(created.requestId);
  const recorded = audit.lifecycle.filter(
    (e) => e.eventType === 'LLM_RECOMMENDATION_RECORDED' || e.eventType === 'LLM_RECOMMENDATION_UNAVAILABLE');
  return outcome('K', 'Restart and replay', 'a request committed while the listener was down is still answered', [
    check('the request was pending before the restart',
      before.status === 'awaiting-recommendation', before.status),
    check('the restarted listener answered it', Boolean(answered), String(Boolean(answered))),
    check('the request reached the auditor', after.status === 'awaiting-auditor', after.status),
    check('exactly one recommendation event exists', recorded.length === 1,
      `${recorded.length}: ${recorded.map((e) => e.eventType).join(',')}`),
  ], {
    requestId: created.requestId,
    statusBefore: before.status,
    statusAfter: after.status,
    recommendationEvents: recorded.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** L: two concurrent deliveries of the same event record exactly one answer. */
async function scenarioL(created, modelUrl) {
  const settled = await Promise.allSettled([
    answerWith(created.requestId, modelUrl),
    answerWith(created.requestId, modelUrl),
  ]);
  const fulfilled = settled.filter((r) => r.status === 'fulfilled' && r.value !== null);
  const audit = await trail(created.requestId);
  const recorded = audit.lifecycle.filter(
    (e) => e.eventType === 'LLM_RECOMMENDATION_RECORDED' || e.eventType === 'LLM_RECOMMENDATION_UNAVAILABLE');
  const after = await fabric.evaluate(AUDITOR.org, AUDITOR.user, ACCESS, 'GetRequest', created.requestId);
  return outcome('L', 'Concurrent duplicate events', 'exactly one recommendation is recorded', [
    check('exactly one recommendation event on the ledger', recorded.length === 1,
      `${recorded.length} events`),
    check('the request advanced exactly once', after.status === 'awaiting-auditor', after.status),
    check('at most one delivery produced a submission', fulfilled.length <= 1,
      `${fulfilled.length} of 2 deliveries submitted`),
  ], {
    requestId: created.requestId,
    deliveryOutcomes: settled.map((r) => (r.status === 'fulfilled'
      ? (r.value === null ? 'no-op (already answered)' : 'submitted')
      : `rejected: ${String(r.reason.message).slice(0, 160)}`)),
    recommendationEvents: recorded.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** M: a requester may not decide their own request. */
async function scenarioM() {
  // The requester is an auditor identity, so the only thing stopping them is the
  // chaincode's identity comparison rather than a role check.
  const created = await fabric.submitWithTransient(
    AUDITOR.org, AUDITOR.user, ACCESS, 'CreateAccessRequest',
    ['REC-FIR-001', JSON.stringify({ action: 'view', purpose: 'audit-review', emergencyFlag: false })],
    { justification: Buffer.from('Oversight review of this case file.', 'utf8') },
    fabric.ACCESS_QUERY_ENDORSERS
  );
  await answerWith(created.requestId, process.env.DIAS_MODEL_URL
    || require('../../backend/src/config').DIAS_MODEL_URL);
  let selfRejection = null;
  try {
    await decide(created.requestId, 'FORCE_ALLOW', 'Approving my own request.', '', AUDITOR);
  } catch (error) {
    selfRejection = error.message + (error.details || []).map((d) => ` | ${d.message}`).join('');
  }
  const byOther = await decide(created.requestId, 'FORCE_DENY', 'Reviewed by a different auditor.', '', OTHER_AUDITOR);
  return outcome('M', 'Requester decides their own request', 'rejected; another auditor can decide', [
    check('the self-decision was rejected', selfRejection !== null, String(selfRejection).slice(0, 200)),
    check('the rejection names the reason', /cannot decide their own request/.test(selfRejection || ''),
      String(selfRejection).slice(0, 200)),
    check('a different auditor could decide it',
      byOther.accessOutcome.outcome === 'DENIED', byOther.accessOutcome.outcome),
  ], {
    requestId: created.requestId,
    requester: AUDITOR.user,
    decidedBy: OTHER_AUDITOR.user,
    rejection: String(selfRejection).slice(0, 400),
  });
}

/** N: an organisation other than the AI org may not record a recommendation. */
async function scenarioN(created) {
  const attempts = [];
  for (const who of [{ org: 'police', user: 'insp.sharma' }, AUDITOR]) {
    try {
      await fabric.submit(who.org, who.user, ACCESS, 'SubmitLLMRecommendation',
        created.requestId, JSON.stringify({
          recommendation: 'ALLOW', reason_code: 'POLICY_SATISFIED', reason: 'forged',
          policy_refs: ['GP-DEFAULT:C1@v1'], missing_evidence: [], review_flags: [],
        }), JSON.stringify({}), 'A'.repeat(86) + '==');
      attempts.push({ who: `${who.org}/${who.user}`, rejected: false, message: 'ACCEPTED' });
    } catch (error) {
      const message = error.message + (error.details || []).map((d) => ` | ${d.message}`).join('');
      attempts.push({ who: `${who.org}/${who.user}`, rejected: true, message: message.slice(0, 200) });
    }
  }
  return outcome('N', 'Unauthorized organisation recommends', 'rejected for every non-AI identity',
    attempts.map((attempt) => check(`${attempt.who} was refused`, attempt.rejected, attempt.message)),
    { requestId: created.requestId, attempts });
}

/**
 * O: facts change after the recommendation — the stale decision is refused and a
 * new recommendation is required.
 */
async function scenarioO(created) {
  const before = await review(created.requestId);
  // Seal the record after the model answered. The auditor is now looking at a
  // recommendation formed on facts that no longer hold.
  await fabric.submit('court', 'judge.rana', 'RecordContract', 'SealRecord', created.recordId);
  let rejection = null;
  try {
    await decide(created.requestId, 'FORCE_ALLOW', 'Approving despite the change.', '', OTHER_AUDITOR);
  } catch (error) {
    rejection = error.message + (error.details || []).map((d) => ` | ${d.message}`).join('');
  }
  await fabric.submit('court', 'judge.rana', 'RecordContract', 'UnsealRecord', created.recordId);
  const stillPending = await fabric.evaluate(
    AUDITOR.org, AUDITOR.user, ACCESS, 'GetRequest', created.requestId);
  return outcome('O', 'Facts change after the recommendation', 'the stale decision is refused', [
    check('a recommendation existed before the change',
      before.recommendation?.generationStatus === 'OK', before.recommendation?.generationStatus),
    check('the decision on stale facts was refused', rejection !== null, String(rejection).slice(0, 200)),
    check('the refusal names the changed facts',
      /changed|no longer|verified request/i.test(rejection || ''), String(rejection).slice(0, 200)),
    check('the request was not settled by the refused decision',
      stillPending.status === 'awaiting-auditor', stillPending.status),
  ], {
    requestId: created.requestId,
    recordId: created.recordId,
    changeApplied: 'RecordContract.SealRecord then UnsealRecord',
    rejection: String(rejection).slice(0, 400),
  });
}

module.exports = {
  answerWith, scenarioI, scenarioJ, scenarioK, scenarioL, scenarioM, scenarioN, scenarioO,
  startProseServer, submitWithoutAnswer,
};
