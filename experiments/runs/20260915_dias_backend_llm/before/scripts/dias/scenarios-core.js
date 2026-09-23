'use strict';

/**
 * Live scenarios A–H: the authority model and the dynamic-authorization
 * lifecycle, exercised against committed Fabric state.
 */

const {
  ACCESS, AUDITOR, OTHER_AUDITOR, check, decide, outcome, review, sleep,
  submitAndAwait, trail,
} = require('./live-scenarios');
const fabric = require('../../backend/src/fabric/gateway');

const CROSS_DISTRICT = Object.freeze({
  requester: { org: 'police', user: 'insp.singh' },
  recordId: 'REC-FIR-001',
  body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
  justification: 'I need the FIR for a related enquiry I am running.',
});
const ASSIGNED = Object.freeze({
  requester: { org: 'police', user: 'insp.sharma' },
  recordId: 'REC-FIR-001',
  body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
  justification: 'I am investigating CASE-2026-001 and need to read the FIR.',
});

const run = (spec, overrides = {}) => submitAndAwait(
  overrides.requester || spec.requester,
  overrides.recordId || spec.recordId,
  { ...spec.body, ...(overrides.body || {}) },
  overrides.justification || spec.justification
);

const recommendationOf = async (requestId) => (await review(requestId)).recommendation || {};

/** A: model ALLOW, auditor FORCE_ALLOW — grant, and no authorization created. */
async function scenarioA() {
  const request = await run(ASSIGNED);
  const recommendation = await recommendationOf(request.requestId);
  if (recommendation.recommendation !== 'ALLOW') {
    return outcome('A', 'Model ALLOW + auditor FORCE_ALLOW', 'grant, no dynamic authorization',
      [check('model recommended ALLOW', false,
        `model recommended ${recommendation.recommendation}; scenario not exercisable on this candidate`)],
      { requestId: request.requestId });
  }
  // Agreeing with the recommendation needs no override reason.
  const result = await decide(request.requestId, 'FORCE_ALLOW', '');
  const after = await trail(request.requestId);
  return outcome('A', 'Model ALLOW + auditor FORCE_ALLOW', 'grant, no dynamic authorization', [
    check('access outcome is GRANTED', result.accessOutcome.outcome === 'GRANTED', result.accessOutcome.outcome),
    check('basis is the auditor decision', result.accessOutcome.basis === 'AUDITOR_DECISION', result.accessOutcome.basis),
    check('no dynamic authorization created', result.dynamicAuthorization === null,
      String(result.dynamicAuthorization)),
    check('auditor decision not marked an override', result.auditorDecision.override === false,
      String(result.auditorDecision.override)),
    check('lifecycle holds no DYNAMIC_AUTHORIZATION_CREATED',
      !after.lifecycle.some((e) => e.eventType === 'DYNAMIC_AUTHORIZATION_CREATED'),
      after.lifecycle.map((e) => e.eventType).join(',')),
  ], {
    requestId: request.requestId,
    requestTxId: request.txId,
    recommendationTxId: (await review(request.requestId)).recommendation.txId,
    auditorTxId: result.auditorDecision.txId,
    outcomeId: result.accessOutcome.outcomeId,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** B: model DENY, auditor FORCE_DENY — deny, and no authorization created. */
async function scenarioB() {
  const request = await run(CROSS_DISTRICT);
  const recommendation = await recommendationOf(request.requestId);
  if (recommendation.recommendation !== 'DENY') {
    return outcome('B', 'Model DENY + auditor FORCE_DENY', 'deny, no dynamic authorization',
      [check('model recommended DENY', false,
        `model produced ${recommendation.generationStatus}/${recommendation.recommendation}; `
        + 'scenario not exercisable on this candidate')],
      { requestId: request.requestId });
  }
  // Agreeing with the recommendation needs no override reason; the chaincode
  // requires one only when the auditor differs or nothing was recommended.
  const result = await decide(request.requestId, 'FORCE_DENY', '');
  const after = await trail(request.requestId);
  return outcome('B', 'Model DENY + auditor FORCE_DENY', 'deny, no dynamic authorization', [
    check('model recommended DENY', recommendation.recommendation === 'DENY',
      `${recommendation.recommendation} (${recommendation.reasonCode})`),
    check('access outcome is DENIED', result.accessOutcome.outcome === 'DENIED', result.accessOutcome.outcome),
    check('no dynamic authorization created', result.dynamicAuthorization === null,
      String(result.dynamicAuthorization)),
    check('lifecycle holds no DYNAMIC_AUTHORIZATION_CREATED',
      !after.lifecycle.some((e) => e.eventType === 'DYNAMIC_AUTHORIZATION_CREATED'),
      after.lifecycle.map((e) => e.eventType).join(',')),
  ], {
    requestId: request.requestId,
    requestTxId: request.txId,
    auditorTxId: result.auditorDecision.txId,
    outcomeId: result.accessOutcome.outcomeId,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** C: model DENY, auditor FORCE_ALLOW — grant AND create an exact authorization. */
async function scenarioC(validUntilUtc = '') {
  const request = await run(CROSS_DISTRICT);
  const recommendation = await recommendationOf(request.requestId);
  if (recommendation.recommendation !== 'DENY') {
    return {
      result: outcome('C', 'Model DENY + auditor FORCE_ALLOW', 'grant and create an exact authorization',
        [check('model recommended DENY', false, `model recommended ${recommendation.recommendation}`)],
        { requestId: request.requestId }),
      authorization: null,
    };
  }
  const reason = 'Cross-district access approved for a joint enquiry; recorded by the auditor.';
  const result = await decide(request.requestId, 'FORCE_ALLOW', reason, validUntilUtc);
  const after = await trail(request.requestId);
  const authorization = result.dynamicAuthorization;
  return {
    result: outcome('C', 'Model DENY + auditor FORCE_ALLOW', 'grant and create an exact authorization', [
      check('access outcome is GRANTED', result.accessOutcome.outcome === 'GRANTED', result.accessOutcome.outcome),
      check('dynamic authorization created', Boolean(authorization),
        authorization ? authorization.authorizationId : 'none'),
      check('decision recorded as an override', result.auditorDecision.override === true,
        String(result.auditorDecision.override)),
      check('authorization scope is exact-record',
        authorization?.scope?.scopeVersion === 'dias-authorization-scope-exact-record-v1',
        authorization?.scope?.scopeVersion),
      check('authorization names the originating request',
        authorization?.originatingRequestId === request.requestId, authorization?.originatingRequestId),
      check('authorization origin is DENY then FORCE_ALLOW',
        authorization?.originalLlmRecommendation?.recommendation === 'DENY'
        && authorization?.auditorDecision?.decision === 'FORCE_ALLOW',
        `${authorization?.originalLlmRecommendation?.recommendation}/${authorization?.auditorDecision?.decision}`),
      check('lifecycle records DYNAMIC_AUTHORIZATION_CREATED',
        after.lifecycle.some((e) => e.eventType === 'DYNAMIC_AUTHORIZATION_CREATED'),
        after.lifecycle.map((e) => e.eventType).join(',')),
    ], {
      requestId: request.requestId,
      requestTxId: request.txId,
      auditorTxId: result.auditorDecision.txId,
      authorizationId: authorization?.authorizationId,
      authorizationScope: authorization?.scope,
      validUntilUtc: authorization?.validUntilUtc,
      lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
    }),
    authorization,
  };
}

/** D: the exact same request again — automatic grant, model and auditor skipped. */
async function scenarioD(authorizationId) {
  const request = await run(CROSS_DISTRICT);
  const after = await trail(request.requestId);
  const events = after.lifecycle.map((e) => e.eventType);
  return outcome('D', 'Exact repeat of an authorized request', 'automatic grant, model and auditor skipped', [
    check('granted without reaching the model', request.status === 'granted', request.status),
    check('processing path is the dynamic authorization',
      request.processingPath === 'dynamic-authorization', request.processingPath),
    check('model recorded as skipped', request.llmRecommendationStatus === 'SKIPPED',
      request.llmRecommendationStatus),
    check('auditor recorded as skipped', request.auditorReviewStatus === 'SKIPPED',
      request.auditorReviewStatus),
    check('the matched authorization is the one created in C',
      request.dynamicAuthorizationCheck.authorizationId === authorizationId,
      `${request.dynamicAuthorizationCheck.authorizationId} vs ${authorizationId}`),
    check('lifecycle records both skips and the outcome',
      events.includes('LLM_RECOMMENDATION_SKIPPED') && events.includes('AUDITOR_REVIEW_SKIPPED')
      && events.includes('ACCESS_OUTCOME_RECORDED'), events.join(',')),
    check('no recommendation was recorded', after.llmRecommendation === null,
      String(after.llmRecommendation)),
  ], {
    requestId: request.requestId,
    requestTxId: request.txId,
    matchedAuthorizationId: request.dynamicAuthorizationCheck.authorizationId,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/**
 * E: near misses. Each variant changes exactly one scope field, so a match would
 * mean the scope is not exact.
 */
async function scenarioE(authorizationId) {
  const variants = [
    ['different record', { recordId: 'REC-EVIDENCE-001' }],
    ['different action', { body: { action: 'export' } }],
    ['different purpose', { body: { purpose: 'prosecution' } }],
    ['different user', { requester: { org: 'police', user: 'insp.rathore' } }],
  ];
  const checks = [];
  const evidence = [];
  for (const [name, override] of variants) {
    const request = await run(CROSS_DISTRICT, override);
    const matched = request.dynamicAuthorizationCheck.matched;
    const reused = matched
      && request.dynamicAuthorizationCheck.authorizationId === authorizationId;
    checks.push(check(`${name} does not reuse the authorization`, !reused,
      `outcome=${request.dynamicAuthorizationCheck.outcome} matched=${matched}`));
    evidence.push({
      variant: name,
      requestId: request.requestId,
      txId: request.txId,
      status: request.status,
      checkOutcome: request.dynamicAuthorizationCheck.outcome,
      scopeHash: request.authorizationScopeHash,
    });
  }
  return outcome('E', 'Near misses', 'no near miss reuses the authorization', checks, { variants: evidence });
}

/** F: revocation stops automatic reuse. */
async function scenarioF(authorizationId) {
  const reason = 'Joint enquiry concluded; standing access withdrawn by the auditor.';
  const revoked = await fabric.submit(
    AUDITOR.org, AUDITOR.user, ACCESS, 'RevokeDynamicAuthorization', authorizationId, reason);
  const request = await run(CROSS_DISTRICT);
  const after = await trail(request.requestId);
  return outcome('F', 'Revocation', 'a revoked authorization stops automatic reuse', [
    check('authorization status is revoked', revoked.status === 'revoked', revoked.status),
    check('revocation carries a reason', revoked.revocationReason === reason, String(revoked.revocationReason)),
    check('revocation names who did it and when',
      Boolean(revoked.revokedBy?.username) && Boolean(revoked.revokedAtUtc),
      `${revoked.revokedBy?.username} at ${revoked.revokedAtUtc}`),
    check('the repeat request was not granted automatically',
      request.processingPath !== 'dynamic-authorization', request.processingPath),
    check('the check reports REVOKED', request.dynamicAuthorizationCheck.outcome === 'REVOKED',
      request.dynamicAuthorizationCheck.outcome),
    check('the repeat request reached the auditor queue',
      request.status === 'awaiting-auditor', request.status),
  ], {
    authorizationId,
    revocationTxId: revoked.revocationTxId,
    revokedBy: revoked.revokedBy,
    revocationReason: revoked.revocationReason,
    repeatRequestId: request.requestId,
    repeatTxId: request.txId,
    lifecycle: after.lifecycle.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** G: an expired authorization stops automatic reuse. */
async function scenarioG() {
  // The window has to outlast a real inference call plus two commits, or the
  // authorization expires before the "still valid" half of the test can run and
  // the scenario measures the harness rather than the ledger.
  const windowMs = 180000;
  const validUntilUtc = new Date(Date.now() + windowMs).toISOString();
  const created = await scenarioC(validUntilUtc);
  if (!created.authorization) {
    return outcome('G', 'Expiry', 'an expired authorization stops automatic reuse',
      [check('an authorization was created to expire', false, 'scenario C did not create one')], {});
  }
  const expiresAt = new Date(created.authorization.validUntilUtc).getTime();
  const remainingMs = expiresAt - Date.now();
  const immediate = await run(CROSS_DISTRICT);
  // Wait past the recorded expiry, with a margin for the ledger's own clock.
  await sleep(Math.max(0, expiresAt - Date.now()) + 5000);
  const afterExpiry = await run(CROSS_DISTRICT);
  const authorization = await fabric.evaluate(
    AUDITOR.org, AUDITOR.user, ACCESS, 'GetDynamicAuthorization',
    created.authorization.authorizationId);
  return outcome('G', 'Expiry', 'an expired authorization stops automatic reuse', [
    check('the window outlasted the setup', remainingMs > 30000, `${Math.round(remainingMs / 1000)} s left after creation`),
    check('before expiry the authorization still grants automatically',
      immediate.processingPath === 'dynamic-authorization', immediate.processingPath),
    check('after expiry the request is not granted automatically',
      afterExpiry.processingPath !== 'dynamic-authorization', afterExpiry.processingPath),
    check('the check reports EXPIRED',
      afterExpiry.dynamicAuthorizationCheck.outcome === 'EXPIRED',
      afterExpiry.dynamicAuthorizationCheck.outcome),
    check('the authorization state moved to expired',
      authorization.authorization.status === 'expired', authorization.authorization.status),
    check('an expiry lifecycle event was recorded',
      authorization.events.some((e) => e.eventType === 'DYNAMIC_AUTHORIZATION_EXPIRED'),
      authorization.events.map((e) => e.eventType).join(',')),
  ], {
    authorizationId: created.authorization.authorizationId,
    validUntilUtc: created.authorization.validUntilUtc,
    secondsLeftAfterCreation: Math.round(remainingMs / 1000),
    beforeExpiryRequestId: immediate.requestId,
    beforeExpiryPath: immediate.processingPath,
    afterExpiryRequestId: afterExpiry.requestId,
    afterExpiryOutcome: afterExpiry.dynamicAuthorizationCheck.outcome,
    authorizationEvents: authorization.events.map((e) => ({ seq: e.seq, eventType: e.eventType, txId: e.txId })),
  });
}

/** H: model ALLOW, auditor FORCE_DENY — deny, and never an authorization. */
async function scenarioH() {
  const request = await run(ASSIGNED, {
    justification: 'I am investigating CASE-2026-001 and must read the FIR today.',
  });
  const recommendation = await recommendationOf(request.requestId);
  if (recommendation.recommendation !== 'ALLOW') {
    return outcome('H', 'Model ALLOW + auditor FORCE_DENY', 'deny, no dynamic authorization',
      [check('model recommended ALLOW', false, `model recommended ${recommendation.recommendation}`)],
      { requestId: request.requestId });
  }
  const reason = 'Withheld pending a separate conduct enquiry into this officer.';
  const result = await decide(request.requestId, 'FORCE_DENY', reason);
  const after = await trail(request.requestId);
  return outcome('H', 'Model ALLOW + auditor FORCE_DENY', 'deny, no dynamic authorization', [
    check('access outcome is DENIED', result.accessOutcome.outcome === 'DENIED', result.accessOutcome.outcome),
    check('no dynamic authorization created', result.dynamicAuthorization === null,
      String(result.dynamicAuthorization)),
    check('decision recorded as an override', result.auditorDecision.override === true,
      String(result.auditorDecision.override)),
    check('lifecycle holds no DYNAMIC_AUTHORIZATION_CREATED',
      !after.lifecycle.some((e) => e.eventType === 'DYNAMIC_AUTHORIZATION_CREATED'),
      after.lifecycle.map((e) => e.eventType).join(',')),
  ], {
    requestId: request.requestId,
    auditorTxId: result.auditorDecision.txId,
    outcomeId: result.accessOutcome.outcomeId,
  });
}

module.exports = {
  ASSIGNED, CROSS_DISTRICT, recommendationOf, run,
  scenarioA, scenarioB, scenarioC, scenarioD, scenarioE, scenarioF, scenarioG, scenarioH,
};
