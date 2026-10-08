#!/usr/bin/env node
'use strict';

// Live check of plan steps 12 and 13 on the running host, after the contract was
// redeployed. It uses synthetic demo identities and records, real Fabric
// transactions and the real model, and it WRITES to the ledger: requests, auditor
// decisions, one dynamic authorization and its revocation. It is an engineering
// check of who can read what, not a model benchmark and not a load test.
//
//   node --env-file-if-exists=.env experiments/check-step13-live.js OUTPUT_DIR [WAITING_REQUEST_ID]
//
// WAITING_REQUEST_ID is a request by insp.sharma that still waits for an auditor;
// without it the check submits a new one.

const fs = require('fs');
const path = require('path');
const { createClient, sleep } = require('../scripts/dias/acceptance-client');
const fabric = require('../backend/src/fabric/gateway');
const { DIAS_REVIEW_STORE_DIR } = require('../backend/src/config');

const output = path.resolve(process.argv[2] || '');
const waitingRequestId = process.argv[3] || null;
const base = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const client = createClient(base);

const RECORD = 'REC-FIR-001';
const REQUESTER = 'insp.sharma';
const AUDITOR = 'sp.north';
const RECOMMENDATION_TIMEOUT_MS = 240000;
const NOTE = 'Live verification on a synthetic demo record (2026-10-08).';
/** Requests the model may well refuse; the first DENY is used for the reuse path. */
const REUSE_CANDIDATES = Object.freeze([
  { username: 'insp.singh', action: 'view', purpose: 'investigation' },
  { username: 'const.verma', action: 'export', purpose: 'investigation' },
  { username: 'analyst.rao', action: 'export', purpose: 'forensic-analysis' },
]);

const report = {
  startedAt: new Date().toISOString(), base, record: RECORD, checks: [], evidence: {}, notExercised: [],
};

function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  return Boolean(ok);
}

const get = (route, username) => client.api('GET', route, { username });
const post = (route, username, body) => client.api('POST', route, { username, body });
const explanation = (requestId, username) => get(`/access/request/${requestId}/recommendation`, username);
const ownTrail = (requestId, username) => get(`/access/request/${requestId}/trail`, username);
const text = (value) => JSON.stringify(value === undefined ? null : value);

/** Wait until the recommendation of a request is committed (or has failed). */
async function committedReview(requestId) {
  const deadline = Date.now() + RECOMMENDATION_TIMEOUT_MS;
  for (;;) {
    const response = await client.review(requestId, AUDITOR);
    const converging = response.status === 422 && /does not exist/i.test(String(response.error || ''));
    if (response.status !== 200 && !converging) throw new Error(`review ${requestId}: ${response.status} ${response.error}`);
    if (!converging && ['committed', 'failed', 'commit-rejected'].includes(response.data.recommendationState)) {
      return response.data;
    }
    if (Date.now() > deadline) throw new Error(`no recommendation for ${requestId} in time`);
    await sleep(1000);
  }
}

const recommended = (review) => (review.commitment && review.commitment.generationStatus === 'OK'
  ? review.commitment.recommendation : null);

/** A direct contract read as one identity: { ok, value } or { ok: false, error }. */
async function contractRead(org, username, contract, fn, ...args) {
  try {
    return { ok: true, value: await fabric.evaluate(org, username, contract, fn, ...args) };
  } catch (error) {
    const details = Array.isArray(error.details) ? error.details.map((d) => d.message).join('; ') : '';
    return { ok: false, error: details || error.message };
  }
}

// --- 1. a request that is denied: what the officer may read, before and after ---
async function deniedRequest() {
  let requestId = waitingRequestId;
  if (!requestId) {
    const submitted = await client.submit(REQUESTER, {
      recordId: RECORD, action: 'view', purpose: 'investigation', justification: NOTE,
    });
    check('a new request goes to the auditor', submitted.status === 202, submitted.status);
    requestId = submitted.data.requestId;
  }
  report.evidence.deniedRequestId = requestId;
  const review = await committedReview(requestId);
  const value = recommended(review);
  report.evidence.deniedRequestRecommendation = value || review.recommendationState;

  const before = await ownTrail(requestId, REQUESTER);
  check('before the decision, the officer\'s request trail withholds the recommendation',
    before.status === 200 && before.data.recommendationCommitment
      && before.data.recommendationCommitment.withheldUntilDecision === true
      && !/"recommendation":"(ALLOW|DENY)"/.test(text(before.data)),
    { status: before.status, commitment: before.data && before.data.recommendationCommitment });
  const hidden = await explanation(requestId, REQUESTER);
  check('before the decision, the officer reads nothing from the LLM',
    hidden.status === 200 && hidden.data.withheld === 'awaiting-decision' && hidden.data.recommendation === null
      && hidden.data.reason === null && hidden.data.decision === null,
    { status: hidden.status, withheld: hidden.data && hidden.data.withheld });
  const auditorView = await explanation(requestId, AUDITOR);
  check('the auditor reads the full LLM account before deciding',
    auditorView.status === 200 && auditorView.data.viewer === 'auditor' && auditorView.data.explanationVisible === true,
    { status: auditorView.status, recommendation: auditorView.data && auditorView.data.recommendation });

  const decided = await client.decide(requestId, { decision: 'FORCE_DENY', reason: NOTE }, AUDITOR);
  check('the auditor denies the request', decided.status === 201, { status: decided.status, error: decided.error });
  report.evidence.deniedAgreement = decided.data && decided.data.auditorDecision && decided.data.auditorDecision.llmAgreement;

  const after = await explanation(requestId, REQUESTER);
  const shown = after.data || {};
  check('after the denial, the officer reads the auditor decision',
    after.status === 200 && shown.decision && shown.decision.decision === 'FORCE_DENY'
      && shown.decision.auditor.username === AUDITOR && shown.outcome.outcome === 'DENIED',
    { status: after.status, decision: shown.decision, outcome: shown.outcome });
  check('after the denial, the officer reads the LLM recommendation and its explanation',
    shown.explanationVisible === true && shown.withheld === null
      && (value ? shown.recommendation === value && typeof shown.reason === 'string' && shown.reason.length > 0
        : shown.available === false),
    { recommendation: shown.recommendation, reasonCode: shown.reasonCode, hasReason: Boolean(shown.reason) });
  check('the officer never receives the auditor note or how the recommendation was produced',
    !/noteHash|auditorNote|provenance|latency|promptTokens|modelId/i.test(text(shown)) && !text(shown).includes(NOTE), null);
  const trailAfter = await ownTrail(requestId, REQUESTER);
  check('after the decision, the officer\'s request trail shows the recommendation',
    trailAfter.status === 200 && !trailAfter.data.recommendationCommitment.withheldUntilDecision,
    trailAfter.data && trailAfter.data.recommendationCommitment && trailAfter.data.recommendationCommitment.recommendation);

  for (const username of ['const.verma', 'pp.mehta', 'judge.rana']) {
    const refused = await explanation(requestId, username);
    check(`${username} is refused the LLM account of another officer's request`, refused.status === 403, refused.status);
  }
  const courtTrail = await client.trail(requestId, 'judge.rana');
  check('a court reviewer gets the verification of the off-chain objects, without their text',
    courtTrail.status === 200 && courtTrail.data.offChainReview === undefined
      && Object.values(courtTrail.data.offChainVerification || {}).every((item) => item.status === 'verified')
      && !text(courtTrail.data).includes(NOTE),
    courtTrail.data && courtTrail.data.offChainVerification);
  const auditTrail = await client.trail(requestId, AUDITOR);
  check('an audit district head gets the justification and the auditor note',
    auditTrail.status === 200 && auditTrail.data.offChainReview
      && typeof auditTrail.data.offChainReview.justification === 'string'
      && auditTrail.data.offChainReview.auditorNote && auditTrail.data.offChainReview.auditorNote.reason === NOTE,
    auditTrail.status);
  return requestId;
}

// --- 2. reuse: an authorization grants a repeat request without the LLM ---------
async function cancelAndCheck(requestId, username) {
  const cancelled = await post(`/access/request/${requestId}/cancel`, username);
  const view = await explanation(requestId, username);
  check(`a cancelled request shows ${username} nothing from the LLM`,
    cancelled.status === 200 && view.status === 200 && view.data.withheld === 'no-auditor-decision'
      && view.data.recommendation === null && view.data.outcome && view.data.outcome.outcome === 'CANCELLED',
    { cancel: cancelled.status, withheld: view.data && view.data.withheld, outcome: view.data && view.data.outcome });
}

async function reusePath() {
  for (const candidate of REUSE_CANDIDATES) {
    const spec = {
      recordId: RECORD, action: candidate.action, purpose: candidate.purpose, justification: NOTE,
    };
    const first = await client.submit(candidate.username, spec);
    if (first.status !== 202) {
      report.notExercised.push(`${candidate.username}: first request returned ${first.status} ${first.error || ''}`);
      continue;
    }
    const requestId = first.data.requestId;
    const value = recommended(await committedReview(requestId));
    report.evidence[`recommendationFor_${candidate.username}`] = value || 'none';
    if (value !== 'DENY') {
      await cancelAndCheck(requestId, candidate.username);
      continue;
    }
    const allowed = await client.decide(requestId, { decision: 'FORCE_ALLOW', reason: NOTE }, AUDITOR);
    const authorization = allowed.data && allowed.data.dynamicAuthorization;
    if (!check('FORCE ALLOW over an LLM DENY creates a reusable authorization',
      allowed.status === 201 && authorization && authorization.authorizationId,
      { status: allowed.status, error: allowed.error })) return;
    report.evidence.reuse = { username: candidate.username, firstRequestId: requestId, authorizationId: authorization.authorizationId };
    const grantedView = await explanation(requestId, candidate.username);
    check('after an allow, the officer reads the decision and the recommendation, not the explanation',
      grantedView.status === 200 && grantedView.data.decision.decision === 'FORCE_ALLOW'
        && grantedView.data.recommendation === 'DENY' && grantedView.data.explanationVisible === false
        && grantedView.data.reason === null && grantedView.data.withheld === 'allowed',
      { withheld: grantedView.data && grantedView.data.withheld });

    const repeat = await client.submit(candidate.username, spec);
    const repeatId = repeat.data && repeat.data.requestId;
    check('the repeat request is granted at once by the authorization',
      repeat.status === 201 && repeat.data.automatic === true && repeat.data.processingPath === 'dynamic-authorization',
      { status: repeat.status, processingPath: repeat.data && repeat.data.processingPath });
    await sleep(3000);
    const auditorOnRepeat = await explanation(repeatId, AUDITOR);
    check('no LLM recommendation was made for the reused request',
      auditorOnRepeat.status === 200 && auditorOnRepeat.data.recommendationState === 'not-generated'
        && !fs.existsSync(path.join(DIAS_REVIEW_STORE_DIR, `${repeatId}.json`)),
      auditorOnRepeat.data && auditorOnRepeat.data.recommendationState);
    const requesterOnRepeat = await explanation(repeatId, candidate.username);
    check('a reused authorization shows the officer nothing from the LLM',
      requesterOnRepeat.status === 200 && requesterOnRepeat.data.withheld === 'no-auditor-decision'
        && requesterOnRepeat.data.outcome.basis === 'DYNAMIC_AUTHORIZATION',
      requesterOnRepeat.data && requesterOnRepeat.data.outcome);

    const revoked = await post(`/access/dynamic-authorizations/${authorization.authorizationId}/revoke`, AUDITOR, { reason: NOTE });
    check('the test authorization is revoked again', revoked.status === 200, { status: revoked.status, error: revoked.error });
    const third = await client.submit(candidate.username, spec);
    if (check('after the revocation the same request goes to the auditor again', third.status === 202, third.status)) {
      await committedReview(third.data.requestId);
      await cancelAndCheck(third.data.requestId, candidate.username);
    }
    return;
  }
  report.notExercised.push('reuse path: the model did not recommend DENY for any candidate, so no authorization could be created');
}

// --- 2b. a reviewer or an auditor who made the request is its requester first ----
const OWN_REQUESTERS = Object.freeze([
  { username: 'judge.rana', kind: 'a court reviewer', purpose: 'judicial-proceeding', auditor: false },
  { username: 'dj.north', kind: 'an audit district head', purpose: 'audit-review', auditor: true },
]);

async function ownRequestOfReviewer() {
  for (const own of OWN_REQUESTERS) {
    const submitted = await client.submit(own.username, {
      recordId: RECORD, action: 'view', purpose: own.purpose, justification: NOTE,
    });
    if (submitted.status !== 202) {
      report.notExercised.push(`${own.username}: own request returned ${submitted.status} ${submitted.error || ''}`);
      continue;
    }
    const requestId = submitted.data.requestId;
    report.evidence[`ownRequestOf_${own.username}`] = requestId;
    await committedReview(requestId);
    const leaks = /"(llmR|r)ecommendation":"(ALLOW|DENY)"|noteHash/;

    const before = await ownTrail(requestId, own.username);
    check(`${own.kind}: the trail of their own request withholds the recommendation`,
      before.status === 200 && before.data.isRequester === true
        && before.data.recommendationCommitment.withheldUntilDecision === true && !leaks.test(text(before.data)),
      { status: before.status, viewer: before.data && before.data.viewer });
    const reviewerRoute = await client.trail(requestId, own.username);
    check(`${own.kind}: the reviewer trail of their own request carries no off-chain text`,
      reviewerRoute.status === 200 && reviewerRoute.data.offChainReview === undefined
        && reviewerRoute.data.offChainVerification === undefined && !leaks.test(text(reviewerRoute.data)),
      reviewerRoute.status);
    const hidden = await explanation(requestId, own.username);
    check(`${own.kind}: reads nothing from the LLM about their own request before the decision`,
      hidden.status === 200 && hidden.data.viewer === 'requester' && hidden.data.withheld === 'awaiting-decision'
        && hidden.data.recommendation === null && hidden.data.reason === null,
      { status: hidden.status, viewer: hidden.data && hidden.data.viewer, withheld: hidden.data && hidden.data.withheld });
    if (own.auditor) {
      const ownReview = await client.review(requestId, own.username);
      check('an audit district head is refused the auditor view of their own request',
        ownReview.status === 403, { status: ownReview.status, error: ownReview.error });
      const ownQueue = await get('/access/auditor/pending', own.username);
      const otherQueue = await get('/access/auditor/pending', AUDITOR);
      const lists = (queue) => (queue.data || []).some((item) => item.request.requestId === requestId);
      check('their own request is missing from their auditor queue and present in another district head\'s',
        ownQueue.status === 200 && !lists(ownQueue) && otherQueue.status === 200 && lists(otherQueue),
        { own: ownQueue.status, other: otherQueue.status });
    }

    const decided = await client.decide(requestId, { decision: 'FORCE_DENY', reason: NOTE }, AUDITOR);
    check(`${own.kind}: another district head decides their request`, decided.status === 201,
      { status: decided.status, error: decided.error });
    const after = await explanation(requestId, own.username);
    check(`${own.kind}: after the denial they read the decision and the explanation as the requester`,
      after.status === 200 && after.data.viewer === 'requester' && after.data.decision.decision === 'FORCE_DENY'
        && after.data.explanationVisible === true && !/noteHash|auditorNote/.test(text(after.data)),
      { status: after.status, viewer: after.data && after.data.viewer });
    const trailAfter = await ownTrail(requestId, own.username);
    check(`${own.kind}: their trail then shows the recommendation, and never the digest of the auditor note`,
      trailAfter.status === 200 && !trailAfter.data.recommendationCommitment.withheldUntilDecision
        && !/noteHash/.test(text(trailAfter.data)),
      trailAfter.status);
  }
}

// --- 3. the decision log: full for reviewers, reduced for everyone else --------
async function decisionLog(deniedRequestId) {
  const identifiers = /insp\.|sp\.north|const\.|analyst\.|REC-|REQ-|CASE-|AUTH-|AUDIT-|OUTCOME-/;
  for (const username of [REQUESTER, 'analyst.rao', 'pp.mehta']) {
    const log = await get('/access/decision-log?limit=100', username);
    const entries = (log.data && log.data.entries) || [];
    check(`${username} reads the reduced decision log, without names, files or transactions`,
      log.status === 200 && entries.length > 0 && entries.every((entry) => entry.redacted === true)
        && !identifiers.test(text(entries)),
      { status: log.status, entries: entries.length });
    if (username === REQUESTER) {
      check('the reduced log still shows what was decided and against which recommendation',
        entries.some((entry) => entry.decision === 'FORCE_DENY' && entry.outcome === 'DENIED'
          && ['ALLOW', 'DENY', 'UNAVAILABLE'].includes(entry.llmRecommendation) && entry.requester.organization === 'police'),
        entries.slice(0, 2));
    }
  }
  for (const username of [AUDITOR, 'judge.rana', 'sp.south']) {
    const log = await get('/access/decision-log?limit=100', username);
    const entries = (log.data && log.data.entries) || [];
    const denied = entries.find((entry) => entry.requestId === deniedRequestId);
    check(`${username} reads the full decision log`,
      log.status === 200 && entries.every((entry) => !entry.redacted && entry.requestId)
        && denied && denied.requester.username === REQUESTER && denied.auditor.username === AUDITOR
        && Object.prototype.hasOwnProperty.call(denied, 'generationStatus'),
      { status: log.status, entries: entries.length });
  }
}

// --- 4. record history and evidence, read directly from the contract -----------
async function recordAndEvidence() {
  const history = (org, username) => contractRead(org, username, 'RecordContract', 'GetRecordHistory', RECORD);
  const evidence = (org, username) => contractRead(org, username, 'RecordContract', 'ListEvidence', RECORD);
  for (const [org, username, allowed, why] of [
    ['police', REQUESTER, true, 'owning station'],
    ['court', 'judge.rana', true, 'reviewer'],
    ['audit', AUDITOR, true, 'reviewer'],
    ['police', 'insp.singh', false, 'another station'],
    ['forensics', 'analyst.rao', false, 'another organization'],
    ['prosecution', 'pp.mehta', false, 'reviewer organization without the role'],
  ]) {
    const result = await history(org, username);
    check(`record history is ${allowed ? 'readable by' : 'refused for'} ${username} (${why})`,
      allowed ? result.ok && Array.isArray(result.value) && result.value.length > 0
        : !result.ok && /unauthorized: GetRecordHistory/.test(result.error),
      result.ok ? `${result.value.length} entries` : result.error);
  }
  for (const [org, username, allowed, why] of [
    ['forensics', 'analyst.rao', true, 'same-district forensics'],
    ['prosecution', 'pp.mehta', true, 'same-district prosecution'],
    ['police', REQUESTER, true, 'same-district police'],
    ['audit', 'sp.south', true, 'reviewer of another district'],
    ['police', 'insp.singh', false, 'another district'],
  ]) {
    const result = await evidence(org, username);
    check(`the evidence list is ${allowed ? 'readable by' : 'refused for'} ${username} (${why})`,
      allowed ? result.ok && Array.isArray(result.value) : !result.ok && /unauthorized: ListEvidence/.test(result.error),
      result.ok ? `${result.value.length} items` : result.error);
  }
  // The private evidence detail follows the same district rule. No such evidence
  // item exists, so an allowed caller gets "no private detail", never "unauthorized".
  const detail = (org, username) => contractRead(org, username, 'RecordContract', 'GetEvidenceDetail', RECORD, 'EV-NONE');
  const refusedDetail = await detail('police', 'insp.singh');
  check('the private evidence detail is refused for insp.singh (another district)',
    !refusedDetail.ok && /unauthorized: GetEvidenceDetail/.test(refusedDetail.error), refusedDetail.error);
  const allowedDetail = await detail('forensics', 'analyst.rao');
  check('the private evidence detail passes the district check for analyst.rao (same district)',
    !allowedDetail.ok && /no private detail/.test(allowedDetail.error) && !/unauthorized/.test(allowedDetail.error),
    allowedDetail.error);
  const viaApi = await get(`/records/${RECORD}/evidence`, 'insp.singh');
  check('the API passes the evidence refusal on as 403', viaApi.status === 403, viaApi.status);
}

// --- 5. the review store on disk -------------------------------------------------
function storeAtRest() {
  const files = fs.readdirSync(DIAS_REVIEW_STORE_DIR).filter((name) => name.endsWith('.json'));
  const clear = files.filter((name) => {
    const raw = fs.readFileSync(path.join(DIAS_REVIEW_STORE_DIR, name), 'utf8');
    return JSON.parse(raw).schemaVersion !== 'dias-offchain-review-encrypted-v1' || raw.includes('justification');
  });
  check('every review on disk is encrypted', files.length > 0 && clear.length === 0, { files: files.length, clear });
}

async function main() {
  if (!process.argv[2]) throw new Error('usage: check-step13-live.js OUTPUT_DIR [WAITING_REQUEST_ID]');
  fs.mkdirSync(output, { recursive: true });
  const resultFile = path.join(output, 'step13-live.json');
  if (fs.existsSync(resultFile)) throw new Error('choose a new output directory; prior evidence exists');
  try {
    const health = await client.api('GET', '/health');
    check('backend health', health.status === 200 && health.data === 'ok', health.status);
    const deniedRequestId = await deniedRequest();
    await reusePath();
    await ownRequestOfReviewer();
    await decisionLog(deniedRequestId);
    await recordAndEvidence();
    storeAtRest();
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
  } finally {
    const failed = report.checks.filter((item) => !item.ok).length;
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.checks.length - failed, failed, total: report.checks.length };
    report.status = failed === 0 && !report.error ? 'passed' : 'failed';
    fs.writeFileSync(resultFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.summary.passed}/${report.summary.total} checks passed; not exercised: ${report.notExercised.length}`);
    process.exit(report.status === 'passed' ? 0 : 1);
  }
}

main();
