#!/usr/bin/env node
'use strict';

/** The reusable-authorization path across the phone and the Mac, once. */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  createClient, now, parseInstrumentation, round, waitForRecommendation,
} = require('./lib');

const API = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const PHONE_API = process.env.DIAS_PHONE_API_URL || 'http://10.0.2.2:3001';
const ADB = process.env.ADB || path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const APP_ID = 'org.dias.mobile.dev';
const PHONE_TEST = 'org.dias.mobile.screen.LiveHostScreenTest#anAuditorDecidesANamedRequestOnThePhoneAndTheLogShowsIt';
const RUNNER = `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;
const AUDITOR = 'sp.north';
/** A cross-district inspector: the written policy denies this request. */
const REQUEST = Object.freeze({ username: 'insp.singh', recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation' });
const NOTE = 'Synthetic end-to-end check of the reusable authorization; no real case material is evaluated.';
const SCREENSHOTS = ['auditor-review', 'auditor-confirm', 'auditor-confirmed', 'auditor-access-log'];

const run = (file, args, options = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 240000, maxBuffer: 32 * 1024 * 1024, ...options },
    (error, stdout) => resolve({ error, stdout }));
});

async function main() {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  if (!out || process.argv.indexOf('--out') === -1) throw new Error('usage: reuse-scenario.js --out DIR');
  fs.mkdirSync(out, { recursive: true });
  const client = createClient(API);
  const report = { startedAtUtc: new Date().toISOString(), request: REQUEST, auditor: AUDITOR, checks: [], evidence: {} };
  const check = (name, ok, detail = null) => {
    report.checks.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };
  const submit = (step) => client.post('/access/request', REQUEST.username,
    { ...REQUEST, username: undefined, justification: `${NOTE} Step ${step}.` });
  const followAdvice = async (requestId) => {
    await waitForRecommendation(client, requestId, AUDITOR);
    const review = await client.get(`/access/auditor/${requestId}`, AUDITOR);
    const advice = review.data.commitment && review.data.commitment.recommendation;
    const decision = advice === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY';
    const decided = await client.post(`/access/auditor/${requestId}/decision`, AUDITOR,
      { decision, reason: advice ? '' : NOTE });
    return { advice, decision, status: decided.status };
  };
  let authorizationId = null;

  try {
    const active = await client.get('/access/dynamic-authorizations?status=active', AUDITOR);
    if (active.data.length !== 0) throw new Error('an authorization is already active; this scenario needs a clean start');

    const first = await submit(1);
    if (first.status !== 202) throw new Error(`first request ${first.status}: ${first.error}`);
    const requestId = first.data.requestId;
    report.evidence.overriddenRequestId = requestId;
    await waitForRecommendation(client, requestId, AUDITOR);
    const review = await client.get(`/access/auditor/${requestId}`, AUDITOR);
    const advice = review.data.commitment && review.data.commitment.recommendation;
    check('the LLM recommends DENY for the cross-district request, and the advice is committed and verified',
      advice === 'DENY' && review.data.integrity.status === 'verified', `advice ${advice}`);
    if (advice !== 'DENY') {
      const closed = await client.post(`/access/auditor/${requestId}/decision`, AUDITOR,
        { decision: advice === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY', reason: advice ? '' : NOTE });
      report.evidence.closedWithoutOverride = closed.status;
      throw new Error('the model did not recommend DENY, so the override was not forced');
    }

    // 2. The override is made on the phone screen.
    const phone = await run(ADB, ['shell', 'am', 'instrument', '-w', '-e', 'class', PHONE_TEST, '-e', 'apiBase', PHONE_API,
      '-e', 'reviewerUsername', AUDITOR, '-e', 'decisionRequestId', requestId, '-e', 'decision', 'FORCE_ALLOW',
      '-e', 'allowAuthorization', 'true', '-e', 'decisionReason', `'${NOTE}'`, RUNNER]);
    const verdict = parseInstrumentation(phone.stdout);
    check('the auditor grants over the DENY on the phone, and the phone shows it confirmed and first in its access log',
      verdict.ok, verdict.detail);
    if (!verdict.ok) throw new Error('the phone step failed; read the request before anything else is done');
    for (const name of SCREENSHOTS) {
      const image = await run(ADB, ['exec-out', 'run-as', APP_ID, 'cat', `cache/evidence/${name}.png`], { encoding: 'buffer' });
      if (image.stdout && image.stdout.length > 1000) fs.writeFileSync(path.join(out, `phone-${name}.png`), image.stdout);
    }
    const trail = await client.get(`/audit/request-trail/${requestId}`, AUDITOR);
    if (trail.status !== 200 || !trail.data.auditorDecision) throw new Error(`the trail of the override could not be read (${trail.status})`);
    const overridden = trail.data;
    authorizationId = overridden.auditorDecision.createdAuthorizationId || null;
    report.evidence.authorizationId = authorizationId;
    check('the ledger records FORCE_ALLOW against the LLM (NOT_AGREED), with the digest of the auditor note',
      overridden.auditorDecision && overridden.auditorDecision.decision === 'FORCE_ALLOW'
      && overridden.auditorDecision.llmAgreement === 'NOT_AGREED' && Boolean(overridden.auditorDecision.noteHash)
      && overridden.offChainVerification.note.status === 'verified');
    check('that decision created one reusable authorization for exactly this scope', Boolean(authorizationId)
      && overridden.accessOutcome.outcome === 'GRANTED', authorizationId);
    if (!authorizationId) throw new Error('no authorization was created, so there is nothing to reuse or revoke');

    // 3. The same request again, on the Mac: granted by the authorization.
    const repeatedAt = now();
    const repeated = await submit(2);
    const reuseMs = round(now() - repeatedAt);
    report.evidence.reusedRequestId = repeated.data && repeated.data.requestId;
    report.evidence.reuseMs = reuseMs;
    check('the repeated request on the Mac is granted at once by the authorization',
      repeated.status === 201 && repeated.data.automatic === true && repeated.data.status === 'granted', `${reuseMs} ms`);
    if (repeated.status === 202) {
      // It was not reused: it now waits for an auditor. Close it rather than leave it.
      const closed = await followAdvice(repeated.data.requestId);
      throw new Error(`the repeated request was not reused; it was closed by following the advice (${closed.decision})`);
    }
    if (repeated.status !== 201) throw new Error(`the repeated request failed: ${repeated.status} ${repeated.error}`);
    const reusedTrail = (await client.get(`/audit/request-trail/${repeated.data.requestId}`, AUDITOR)).data;
    const stages = reusedTrail.lifecycle.map((event) => event.eventType);
    check('the reused request has no LLM recommendation and no auditor decision on the ledger',
      reusedTrail.recommendationCommitment === null && !reusedTrail.auditorDecision
      && stages.includes('AUDITOR_REVIEW_SKIPPED') && reusedTrail.summary.dynamicAuthorization.outcome === 'MATCH',
      stages.join(' > '));
    const log = (await client.get('/access/workflow-log?limit=100', AUDITOR)).data.entries;
    const reusedEntry = log.find((entry) => entry.requestId === repeated.data.requestId) || {};
    check('the access log shows the reuse as granted by the authorization, with the LLM not asked',
      reusedEntry.outcome === 'GRANTED' && reusedEntry.basis === 'DYNAMIC_AUTHORIZATION'
      && reusedEntry.llmRecommendation === null && reusedEntry.authorizationId === authorizationId);

    // 4. Revocation, on the Mac.
    const revoked = await client.post(`/access/dynamic-authorizations/${authorizationId}/revoke`, AUDITOR, { reason: NOTE });
    check('the auditor revokes the authorization', revoked.status === 200, `status ${revoked.status}`);
    if (revoked.status !== 200) throw new Error('the revocation failed, so the request is not repeated');

    // 5. The same request once more: an auditor is needed again.
    const third = await submit(3);
    report.evidence.afterRevocationRequestId = third.data && third.data.requestId;
    check('after the revocation the same request waits for an auditor again',
      third.status === 202 && third.data.status === 'awaiting-auditor', `status ${third.status}`);
    if (third.status === 202) {
      const closed = await followAdvice(third.data.requestId);
      check('that request is closed by following the advice', closed.status === 201, `${closed.advice} -> ${closed.decision}`);
    }
  } catch (error) {
    report.error = String(error.message || error);
    console.error(report.error);
  } finally {
    // The scenario began with no active authorization, so any that is active now is its own: revoke it,
    // also when the scenario never learned its number.
    const left = await client.get('/access/dynamic-authorizations?status=active', AUDITOR);
    for (const authorization of (left.status === 200 ? left.data : [])) {
      const revoked = await client.post(`/access/dynamic-authorizations/${authorization.authorizationId}/revoke`,
        AUDITOR, { reason: NOTE });
      check('clean-up: an authorization left active is revoked', revoked.status === 200, authorization.authorizationId);
    }
    const pending = await client.get('/access/auditor/pending', AUDITOR);
    const active = await client.get('/access/dynamic-authorizations?status=active', AUDITOR);
    const waiting = pending.status === 200 ? pending.data.length : null;
    const stillActive = active.status === 200 ? active.data.length : null;
    check('nothing is left waiting and no authorization is left active',
      waiting === 0 && stillActive === 0, `${waiting} waiting, ${stillActive} active`);
    const failed = report.checks.filter((item) => !item.ok).length;
    report.summary = { passed: report.checks.length - failed, failed, error: report.error || null };
    report.finishedAtUtc = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(report, null, 1)}\n`);
    console.log(`${report.summary.passed} passed, ${failed} failed`);
    process.exitCode = failed || report.error ? 1 : 0;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
