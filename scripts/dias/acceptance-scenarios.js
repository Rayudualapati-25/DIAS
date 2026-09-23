'use strict';

/**
 * Live DIAS acceptance scenarios, run through the application backend.
 *
 * The LLM is a real model, so a scenario that needs a particular recommendation
 * first reads what the model recommended and is reported NOT EXERCISED when no
 * request received it, instead of passing quietly.
 */

const {
  check, ledgerOnly, notExercised, scenario, sleep, stagesOf,
} = require('./acceptance-client');

/**
 * LLM data as it would appear in ledger JSON: a field that carries a
 * recommendation, its reason code or policy references, provenance or an
 * attestation, the requester's justification, or the retired AI identity. Field
 * names are matched exactly, so the trail's own `provenanceSource` description
 * of where it read the ledger is not mistaken for LLM provenance.
 */
const LLM_TRACES = /"(recommendation\w*|llmRecommendation\w*|reasonCode|policyRefs|reviewFlags|missingEvidence|provenance|attestation\w*|justification\w*)"\s*:|llm-decider/i;
const REQUEST_STAGES = ['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED'];
const REVIEWED_STAGES = [...REQUEST_STAGES, 'AUDITOR_DECISION_RECORDED', 'ACCESS_OUTCOME_RECORDED'];

const SPECS = Object.freeze({
  assigned: {
    username: 'insp.sharma',
    body: {
      recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
      justification: 'I am investigating CASE-2026-001 and need to read the FIR.',
    },
  },
  crossDistrict: {
    username: 'insp.singh',
    body: {
      recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
      justification: 'I need the FIR for a related enquiry I am running in my district.',
    },
  },
  assignedAnnotate: {
    username: 'insp.sharma',
    body: {
      recordId: 'REC-FIR-001', action: 'annotate', purpose: 'investigation',
      justification: 'I need to add investigation notes to the FIR for my case.',
    },
  },
});

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const llmValue = (review) => {
  const rec = review && review.recommendation;
  return rec && rec.generationStatus === 'OK' ? rec.recommendation : null;
};
const describe = (response) => `${response.status} ${response.error || ''}`.trim();

/** R1: the request log names who asked for which record, and nothing else. */
async function requestLog(client, spec) {
  const submitted = await client.submit(spec.username, spec.body);
  const requestId = submitted.data && submitted.data.requestId;
  const ledger = requestId ? ((await client.request(spec.username, requestId)).data || {}) : {};
  const result = scenario('R1', 'Request log: who requested which record', [
    check('backend accepted the request (202)', submitted.status === 202, describe(submitted)),
    check('request waits for the auditor', ledger.status === 'awaiting-auditor', ledger.status),
    check('ledger names the requester', ledger.requester && ledger.requester.username === spec.username,
      JSON.stringify(ledger.requester)),
    check('ledger names the record, action and purpose', ledger.recordId === spec.body.recordId
      && ledger.action === spec.body.action && ledger.purpose === spec.body.purpose,
    `${ledger.recordId} ${ledger.action} ${ledger.purpose}`),
    check('ledger request holds no justification', !/justification/i.test(JSON.stringify(ledger)), 'request JSON searched'),
  ], { requestId, txId: ledger.txId, submittedAtUtc: ledger.submittedAtUtc });
  return { result, requestId };
}

/** R2: the backend prepared the recommendation, and the ledger holds none of it. */
async function backendRecommendation(client, requestId) {
  const review = await client.readyReview(requestId);
  const trail = (await client.trail(requestId)).data || {};
  const rec = review.recommendation || {};
  const result = scenario('R2', 'LLM recommendation in the backend, not on the ledger', [
    check('recommendation prepared by the backend', review.recommendationState === 'ready', review.recommendationState),
    check('LLM produced a valid ALLOW or DENY', rec.generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(rec.recommendation),
      `${rec.generationStatus} ${rec.recommendation} ${rec.reasonCode}`),
    check('auditor screen receives the justification', Boolean(review.justification), review.justification),
    check('ledger lifecycle holds only the request stages', same(stagesOf(trail), REQUEST_STAGES), stagesOf(trail).join(',')),
    check('ledger trail holds no LLM data', !LLM_TRACES.test(JSON.stringify(ledgerOnly(trail))), 'ledger trail JSON searched'),
  ], {
    requestId,
    recommendation: rec.recommendation,
    reasonCode: rec.reasonCode,
    policyRefs: rec.policyRefs,
    modelId: rec.provenance && rec.provenance.modelId,
    latencyMs: rec.provenance && rec.provenance.latencyMs,
  });
  return { result, review };
}

/** A request whose recommendation is ready, for routing later scenarios. */
async function submitForReview(client, spec) {
  const submitted = await client.submit(spec.username, spec.body);
  const requestId = submitted.data && submitted.data.requestId;
  if (!requestId) throw new Error(`candidate request refused: ${describe(submitted)}`);
  return { spec, requestId, review: await client.readyReview(requestId) };
}

/** R3: FORCE_ALLOW that agrees with an LLM ALLOW. */
async function agreedGrant(client, candidate) {
  const title = 'Decision log: auditor agrees with an LLM ALLOW';
  if (!candidate) return notExercised('R3', title, 'no request received an LLM ALLOW');
  const decided = await client.decide(candidate.requestId, { decision: 'FORCE_ALLOW' });
  const data = decided.data || {};
  const trail = (await client.trail(candidate.requestId)).data || {};
  return scenario('R3', title, [
    check('decision committed without a reason (201)', decided.status === 201, describe(decided)),
    check('decision log records AGREED', data.auditorDecision && data.auditorDecision.llmAgreement === 'AGREED',
      data.auditorDecision && data.auditorDecision.llmAgreement),
    check('access outcome is GRANTED', data.accessOutcome && data.accessOutcome.outcome === 'GRANTED',
      data.accessOutcome && data.accessOutcome.outcome),
    check('no dynamic authorization created', data.dynamicAuthorization === null, String(data.dynamicAuthorization)),
    check('lifecycle: request, decision, outcome', same(stagesOf(trail), REVIEWED_STAGES), stagesOf(trail).join(',')),
  ], { requestId: candidate.requestId, auditorTxId: data.auditorDecision && data.auditorDecision.txId });
}

/** R4: FORCE_ALLOW over an LLM DENY needs a reason and creates the exact-scope authorization. */
async function overrideCreatesAuthorization(client, candidate) {
  const title = 'Decision log: auditor overrides an LLM DENY';
  if (!candidate) return { result: notExercised('R4', title, 'no request received an LLM DENY'), authorization: null };
  const { spec, requestId } = candidate;
  const withoutReason = await client.decide(requestId, { decision: 'FORCE_ALLOW' });
  const reason = 'Supervisor confirmed a joint enquiry that needs this record.';
  const decided = await client.decide(requestId, { decision: 'FORCE_ALLOW', reason });
  const data = decided.data || {};
  const authorization = data.dynamicAuthorization || null;
  const scope = (authorization && authorization.scope) || {};
  const trail = (await client.trail(requestId)).data || {};
  const note = trail.offChainReview && trail.offChainReview.auditorNote;
  const result = scenario('R4', title, [
    check('override without a reason refused (400)', withoutReason.status === 400, describe(withoutReason)),
    check('override with a reason committed (201)', decided.status === 201, describe(decided)),
    check('decision log records NOT_AGREED', data.auditorDecision && data.auditorDecision.llmAgreement === 'NOT_AGREED',
      data.auditorDecision && data.auditorDecision.llmAgreement),
    check('access outcome is GRANTED', data.accessOutcome && data.accessOutcome.outcome === 'GRANTED',
      data.accessOutcome && data.accessOutcome.outcome),
    check('exact-scope dynamic authorization created', scope.recordId === spec.body.recordId
      && scope.action === spec.body.action && scope.purpose === spec.body.purpose
      && String(scope.stableUserId).endsWith(`::${spec.username}`), JSON.stringify(scope)),
    check('authorization records the LLM disagreement',
      authorization && authorization.auditorDecision.llmAgreement === 'NOT_AGREED', JSON.stringify(authorization && authorization.auditorDecision)),
    check('reason kept off-chain only', !JSON.stringify(ledgerOnly(trail)).includes(reason) && note && note.reason === reason,
      JSON.stringify(note)),
  ], { requestId, authorizationId: authorization && authorization.authorizationId });
  return { result, authorization };
}

/** R5: an exact repeat is granted automatically, without the auditor or the LLM. */
async function exactRepeat(client, spec, authorization) {
  const title = 'Exact repeat is granted automatically';
  if (!authorization) return notExercised('R5', title, 'no dynamic authorization was created');
  const repeat = await client.submit(spec.username, spec.body);
  const data = repeat.data || {};
  const check0 = data.dynamicAuthorizationCheck || {};
  const trail = data.requestId ? ((await client.trail(data.requestId)).data || {}) : {};
  return scenario('R5', title, [
    check('granted at once (201)', repeat.status === 201 && data.status === 'granted', `${describe(repeat)} ${data.status}`),
    check('matched the authorization', check0.outcome === 'MATCH' && check0.authorizationId === authorization.authorizationId,
      `${check0.outcome} ${check0.authorizationId}`),
    check('auditor review recorded as skipped', stagesOf(trail).includes('AUDITOR_REVIEW_SKIPPED'), stagesOf(trail).join(',')),
    check('LLM not called: no off-chain review exists', trail.offChainReview === null, JSON.stringify(trail.offChainReview)),
  ], { requestId: data.requestId, authorizationId: authorization.authorizationId });
}

/** R6: changing the record, action, purpose, or user sends the request back to review. */
async function nearMisses(client, spec, authorization) {
  const title = 'Near misses are not reused';
  if (!authorization) return { result: notExercised('R6', title, 'no dynamic authorization was created'), pending: [] };
  const variants = [
    ['different record', spec.username, { ...spec.body, recordId: 'REC-EVIDENCE-001' }],
    ['different action', spec.username, { ...spec.body, action: 'export' }],
    ['different purpose', spec.username, { ...spec.body, purpose: 'prosecution' }],
    ['different user', 'insp.rathore', { ...spec.body }],
  ];
  const checks = [];
  const pending = [];
  for (const [label, username, body] of variants) {
    const submitted = await client.submit(username, body);
    const data = submitted.data || {};
    const outcome = data.dynamicAuthorizationCheck && data.dynamicAuthorizationCheck.outcome;
    checks.push(check(`${label}: waits for the auditor`, submitted.status === 202 && outcome === 'NO_AUTHORIZATION',
      `${describe(submitted)} ${outcome}`));
    if (data.requestId) pending.push({ label, requestId: data.requestId });
  }
  return { result: scenario('R6', title, checks, { pending }), pending };
}

async function closeOne(client, item) {
  const review = await client.readyReview(item.requestId);
  const value = llmValue(review);
  const body = value === 'DENY'
    ? { decision: 'FORCE_DENY' }
    : { decision: 'FORCE_DENY', reason: 'Outside the approved joint enquiry.' };
  const decided = await client.decide(item.requestId, body);
  const data = decided.data || {};
  return {
    ...item,
    llm: value,
    status: decided.status,
    llmAgreement: data.auditorDecision && data.auditorDecision.llmAgreement,
    outcome: data.accessOutcome && data.accessOutcome.outcome,
    authorization: data.dynamicAuthorization,
  };
}

function closedChecks(items, expectedAgreement) {
  return items.flatMap((item) => [
    check(`${item.label}: committed (201)`, item.status === 201, item.status),
    check(`${item.label}: ${expectedAgreement}`, item.llmAgreement === expectedAgreement, item.llmAgreement),
    check(`${item.label}: DENIED`, item.outcome === 'DENIED', item.outcome),
    check(`${item.label}: no dynamic authorization`, item.authorization === null, String(item.authorization)),
  ]);
}

/** R7: FORCE_DENY that agrees with an LLM DENY, on the near misses. */
async function closePending(client, pending) {
  const closed = [];
  for (const item of pending) closed.push(await closeOne(client, item));
  const agreed = closed.filter((item) => item.llm === 'DENY');
  const evidence = { requests: closed.map(({ label, requestId, llm, llmAgreement }) => ({ label, requestId, llm, llmAgreement })) };
  const result = agreed.length === 0
    ? notExercised('R7', 'Decision log: auditor agrees with an LLM DENY', 'no near miss received an LLM DENY', evidence)
    : scenario('R7', 'Decision log: auditor agrees with an LLM DENY', closedChecks(agreed, 'AGREED'), evidence);
  return { result, overriddenAllows: closed.filter((item) => item.llm === 'ALLOW') };
}

/**
 * R8: FORCE_DENY over an LLM ALLOW. Uses a near miss that received ALLOW when
 * there is one; otherwise raises a request the policy allows and overrides it.
 */
async function overrideAllow(client, overriddenAllows, knownAllowSpec = SPECS.assignedAnnotate) {
  const title = 'Decision log: auditor overrides an LLM ALLOW';
  if (overriddenAllows.length > 0) {
    return scenario('R8', title, closedChecks(overriddenAllows, 'NOT_AGREED'),
      { requests: overriddenAllows.map(({ label, requestId }) => ({ label, requestId })) });
  }
  // Re-submit a specification already observed to receive ALLOW in this run.
  // An agreed ALLOW creates no reusable authorization, so this remains a fresh
  // auditor decision and does not depend on an assumed model output.
  const candidate = await submitForReview(client, knownAllowSpec);
  const closed = await closeOne(client, { label: 'known ALLOW replay', requestId: candidate.requestId });
  if (closed.llm !== 'ALLOW') {
    return notExercised('R8', title, `the dedicated candidate received ${closed.llm}`, { requestId: candidate.requestId });
  }
  return scenario('R8', title, closedChecks([closed], 'NOT_AGREED'), { requestId: candidate.requestId });
}

module.exports = {
  LLM_TRACES, SPECS, agreedGrant, backendRecommendation, closeOne, closePending, exactRepeat,
  llmValue, nearMisses, overrideAllow, overrideCreatesAuthorization, requestLog, sleep, submitForReview,
};
