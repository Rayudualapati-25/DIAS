'use strict';

/**
 * Live DIAS acceptance scenarios for the safeguards: revocation and expiry, an
 * auditor deciding their own request, a decision on changed facts, a missing LLM
 * recommendation, the application access log, and the absence of LLM data on the
 * ledger.
 */

const {
  check, ledgerOnly, notExercised, scenario, sleep,
} = require('./acceptance-client');
const { LLM_TRACES, closeOne, llmValue } = require('./acceptance-scenarios');

const describe = (response) => `${response.status} ${response.error || ''}`.trim();
const matchOutcome = (response) => response.data && response.data.dynamicAuthorizationCheck
  && response.data.dynamicAuthorizationCheck.outcome;

/** R9: revocation stops reuse; a renewed authorization with an expiry stops at expiry. */
async function revocationAndExpiry(client, spec, authorization) {
  const title = 'Revocation and expiry stop reuse';
  if (!authorization) return notExercised('R9', title, 'no dynamic authorization was created');
  const revoked = await client.api('POST', `/access/dynamic-authorizations/${authorization.authorizationId}/revoke`, {
    username: 'sp.north', body: { reason: 'The joint enquiry has ended.' },
  });
  const afterRevoke = await client.submit(spec.username, spec.body);
  const checks = [
    check('revocation committed', revoked.status === 200 && revoked.data.status === 'revoked', describe(revoked)),
    check('repeat after revocation waits for the auditor', afterRevoke.status === 202 && matchOutcome(afterRevoke) === 'REVOKED',
      `${describe(afterRevoke)} ${matchOutcome(afterRevoke)}`),
  ];
  const pendingId = afterRevoke.data && afterRevoke.data.requestId;
  if (!pendingId) return scenario('R9', title, checks);
  const review = await client.readyReview(pendingId);
  if (llmValue(review) !== 'DENY') {
    await closeOne(client, { label: 'after revocation', requestId: pendingId });
    checks.push(check('expiry step needs an LLM DENY on the repeat', false, `LLM said ${llmValue(review)}`));
    return scenario('R9', title, checks, { pendingId });
  }
  const validUntilUtc = new Date(Date.now() + 90 * 1000).toISOString();
  const renewed = await client.decide(pendingId, {
    decision: 'FORCE_ALLOW', reason: 'The enquiry reopened for a short window.', validUntilUtc,
  });
  const second = renewed.data && renewed.data.dynamicAuthorization;
  const beforeExpiry = await client.submit(spec.username, spec.body);
  checks.push(
    check('renewed authorization is the next generation, with an expiry', renewed.status === 201 && second
      && second.generation === authorization.generation + 1 && Boolean(second.validUntilUtc),
    `${describe(renewed)} generation=${second && second.generation} after ${authorization.generation}`),
    check('repeat before expiry granted automatically', beforeExpiry.status === 201 && matchOutcome(beforeExpiry) === 'MATCH',
      `${describe(beforeExpiry)} ${matchOutcome(beforeExpiry)}`),
  );
  if (second && second.validUntilUtc) {
    const wait = new Date(second.validUntilUtc).getTime() - Date.now() + 5000;
    if (wait > 0) await sleep(wait);
  }
  const afterExpiry = await client.submit(spec.username, spec.body);
  checks.push(check('repeat after expiry waits for the auditor', afterExpiry.status === 202 && matchOutcome(afterExpiry) === 'EXPIRED',
    `${describe(afterExpiry)} ${matchOutcome(afterExpiry)}`));
  if (afterExpiry.data && afterExpiry.data.requestId) {
    await closeOne(client, { label: 'after expiry', requestId: afterExpiry.data.requestId });
  }
  return scenario('R9', title, checks, {
    revokedAuthorizationId: authorization.authorizationId,
    renewedAuthorizationId: second && second.authorizationId,
    validUntilUtc: second && second.validUntilUtc,
  });
}

/** R10: an auditor cannot decide a request they raised. */
async function selfDecision(client) {
  const title = 'An auditor cannot decide their own request';
  const submitted = await client.submit('sp.north', {
    recordId: 'REC-FIR-001', action: 'view', purpose: 'audit-review',
    justification: 'Periodic oversight review of this FIR.',
  });
  const requestId = submitted.data && submitted.data.requestId;
  if (!requestId) return scenario('R10', title, [check('auditor raised a request', false, describe(submitted))]);
  await client.readyReview(requestId);
  const own = await client.decide(requestId, { decision: 'FORCE_ALLOW', reason: 'Approving my own request.' }, 'sp.north');
  const other = await client.decide(requestId, {
    decision: 'FORCE_DENY', reason: 'Closing: a requester cannot approve their own request.',
  }, 'dj.north');
  return scenario('R10', title, [
    check('own decision refused by the chaincode', own.status === 422 && /cannot decide their own request/.test(own.error || ''),
      describe(own)),
    check('another auditor decided it', other.status === 201, describe(other)),
  ], { requestId });
}

/** R11: a decision made after the governed facts changed is refused. */
async function changedFacts(client) {
  const title = 'A decision on changed facts is refused';
  const recordId = 'REC-JUVENILE-001';
  const submitted = await client.submit('insp.sharma', {
    recordId, action: 'view', purpose: 'investigation',
    justification: 'This record belongs to CASE-2026-002, which I investigate.',
  });
  const requestId = submitted.data && submitted.data.requestId;
  if (!requestId) return scenario('R11', title, [check('request raised', false, describe(submitted))]);
  await client.readyReview(requestId);
  const sealed = await client.api('POST', `/records/${recordId}/seal`, { username: 'judge.rana' });
  const stale = await client.decide(requestId, { decision: 'FORCE_ALLOW', reason: 'Approving after review.' });
  const unsealed = await client.api('POST', `/records/${recordId}/unseal`, { username: 'judge.rana' });
  const fresh = await client.decide(requestId, { decision: 'FORCE_DENY', reason: 'Closing after the facts check.' });
  return scenario('R11', title, [
    check('record sealed after the recommendation', sealed.status === 200, describe(sealed)),
    check('decision on changed facts refused', stale.status === 422 && /facts changed/.test(stale.error || ''), describe(stale)),
    check('record unsealed again', unsealed.status === 200, describe(unsealed)),
    check('decision accepted once the facts match again', fresh.status === 201, describe(fresh)),
  ], { requestId, recordId });
}

/** R12: with no recommendation, the auditor still decides and the ledger says NO_RECOMMENDATION. */
async function noRecommendation(offlineClient) {
  const title = 'No LLM recommendation: the auditor still decides';
  const submitted = await offlineClient.submit('insp.sharma', {
    recordId: 'REC-FIR-001', action: 'export', purpose: 'investigation',
    justification: 'I need an export of the FIR for the case file.',
  });
  const requestId = submitted.data && submitted.data.requestId;
  if (!requestId) return scenario('R12', title, [check('request raised', false, describe(submitted))]);
  const review = await offlineClient.readyReview(requestId, { timeoutMs: 180000 });
  const rec = review.recommendation || {};
  const withoutReason = await offlineClient.decide(requestId, { decision: 'FORCE_ALLOW' });
  const decided = await offlineClient.decide(requestId, {
    decision: 'FORCE_ALLOW', reason: 'Model offline; checked manually against the case file.',
  });
  const data = decided.data || {};
  return scenario('R12', title, [
    check('backend stored a failed generation', review.recommendationState === 'ready'
      && rec.generationStatus === 'UNAVAILABLE' && rec.recommendation === null, `${rec.generationStatus} ${rec.errorCode}`),
    check('decision without a reason refused (400)', withoutReason.status === 400, describe(withoutReason)),
    check('decision committed with NO_RECOMMENDATION', decided.status === 201
      && data.auditorDecision && data.auditorDecision.llmAgreement === 'NO_RECOMMENDATION', describe(decided)),
    check('no dynamic authorization created', data.dynamicAuthorization === null, String(data.dynamicAuthorization)),
  ], { requestId, errorCode: rec.errorCode });
}

/** R13: the application access log records the request and the decision with its agreement. */
async function accessLog(client, requestId, expectedAgreement) {
  const title = 'Application access log: request and decision';
  if (!requestId) return notExercised('R13', title, 'no overridden request to look up');
  const log = await client.api('GET', '/audit/access-log?limit=500', { username: 'sp.north' });
  const entries = (log.data && log.data.entries) || [];
  const byAction = (action) => entries.find((entry) => entry.action === action
    && entry.target && entry.target.requestId === requestId);
  const requested = byAction('access.request');
  const decided = byAction('dias.auditor.decision');
  return scenario('R13', title, [
    check('request event names the requester and record', requested && requested.actorUsername && requested.target.recordId,
      JSON.stringify(requested)),
    check('decision event names the auditor and the LLM agreement', decided && decided.actorUsername
      && decided.target.llmAgreement === expectedAgreement, JSON.stringify(decided)),
  ], { requestId, requestTxId: requested && requested.txId, decisionTxId: decided && decided.txId });
}

/** R14: no ledger trail holds a recommendation, reason, or justification. */
async function noLlmOnLedger(client, requestIds) {
  const checks = [];
  for (const requestId of requestIds) {
    const trail = (await client.trail(requestId)).data || {};
    checks.push(check(`${requestId}: ledger trail holds no LLM data`,
      trail.requestId === requestId && !LLM_TRACES.test(JSON.stringify(ledgerOnly(trail))),
      (trail.lifecycle || []).map((event) => event.eventType).join(',')));
  }
  return scenario('R14', 'The ledger holds no LLM recommendation, reason, or justification', checks, { requestIds });
}

module.exports = {
  accessLog, changedFacts, noLlmOnLedger, noRecommendation, revocationAndExpiry, selfDecision,
};
