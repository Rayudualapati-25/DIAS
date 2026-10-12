#!/usr/bin/env node
'use strict';

// Writes only synthetic demo requests/decisions and one evidence fixture. Any
// authorization created by this check is revoked in finally. Never reset/seed.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createClient, sleep } = require('../scripts/dias/acceptance-client');
const { DIAS_REVIEW_STORE_DIR } = require('../backend/src/config');
const out = path.resolve(process.argv[2] || 'experiments/runs/20261012_portal_workflow_review/live');
const base = process.env.DIAS_API_URL || 'http://localhost:3001/api';
const client = createClient(base);
const report = { startedAt: new Date().toISOString(), base, checks: [], evidence: {} };
const note = 'Synthetic portal workflow verification; no real case material or person is evaluated.';
let authorization;
function check(name, value, detail = null) {
  report.checks.push({ name, ok: Boolean(value), detail });
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
}
const get = (route, username) => client.api('GET', route, { username });
const post = (route, username, body) => client.api('POST', route, { username, body });
async function data(response) {
  const result = await response;
  if (result.status >= 400) throw new Error(`${result.status}: ${result.error}`);
  return result.data;
}

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const { searchForAccess } = await import(pathToFileURL(path.join(__dirname, '../frontend/js/shared/search-access.js')));
  const apiFor = (username) => ({ records: {
    lookup: (id) => data(get(`/records/lookup/${id}`, username)),
    search: (filters) => data(get(`/records?${new URLSearchParams(filters)}`, username)),
    evidenceIndex: (id) => data(get(`/records/evidence-index/${id}`, username)),
  }, access: { request: (body) => data(client.submit(username, body)) } });
  const search = (username, kind, identifier, action = 'view') => searchForAccess({ api: apiFor(username),
    input: { kind, identifier, action, purpose: 'investigation', justification: note } });

  const history = await data(get('/access/requests/mine?limit=100', 'insp.sharma'));
  check('request history is restored from Fabric and restricted to its signing identity',
    history.storage === 'fabric-ledger' && history.entries.length > 0
    && history.entries.every((r) => r.requester.username === 'insp.sharma'));
  check('a non-reviewer cannot read all workflow requests', (await get('/access/workflow-log', 'insp.sharma')).status === 403);
  check('invalid history limit is refused', (await get('/access/requests/mine?limit=0', 'insp.sharma')).status === 400);
  const files = await apiFor('const.verma').records.search({ caseId: 'CASE-2026-001' });
  check('case discovery returns identifiers without protected content', files.length > 0
    && files.every((r) => r.recordId && !r.contentHash && !r.narrative));

  const { request: denied } = await search('const.verma', 'record', 'REC-FIR-001', 'export');
  report.evidence.deniedRequestId = denied.requestId;
  check('Search automatically records a request awaiting review', denied.status === 'awaiting-auditor');
  const pending = (await data(get('/access/workflow-log?limit=100', 'sp.north'))).entries.find((r) => r.requestId === denied.requestId);
  check('pending request and authorization check appear in the blockchain workflow log',
    pending && pending.outcome === null && pending.dynamicAuthorizationCheck && pending.requestTxId);
  const review = await client.readyReview(denied.requestId, { timeoutMs: 240000 });
  check('backend automatically commits its signed LLM recommendation for the auditor',
    review.commitment && review.recommendationState === 'committed' && ['ALLOW', 'DENY'].includes(review.commitment.recommendation));
  const decision = await data(client.decide(denied.requestId, { decision: 'FORCE_DENY', reason: note }));
  check('auditor binding decision is a committed denial', decision.accessOutcome.outcome === 'DENIED');
  const officerDecision = await data(get(`/access/request/${denied.requestId}/recommendation`, 'const.verma'));
  check('requester sees the auditor decision after it is committed', officerDecision.decision?.decision === 'FORCE_DENY');
  const trail = await data(client.trail(denied.requestId));
  const stages = trail.lifecycle.map((e) => e.eventType);
  check('request, authorization check, recommendation, decision and outcome have Fabric lifecycle records',
    ['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED', 'RECOMMENDATION_COMMITTED',
      'AUDITOR_DECISION_RECORDED', 'ACCESS_OUTCOME_RECORDED'].every((stage) => stages.includes(stage)));

  const { request: first } = await search('insp.singh', 'record', 'REC-FIR-001');
  if (first.automatic) throw new Error('Reuse fixture already has active authorization; preserve it and choose another scope.');
  const firstReview = await client.readyReview(first.requestId, { timeoutMs: 240000 });
  check('reuse fixture receives a valid DENY recommendation', firstReview.commitment?.recommendation === 'DENY');
  if (firstReview.commitment?.recommendation !== 'DENY') {
    await data(client.decide(first.requestId, { decision: 'FORCE_DENY', reason: note }));
    throw new Error('Untuned model did not deny reuse fixture; no forced metric or fabricated reuse result.');
  }
  const allowed = await data(client.decide(first.requestId, { decision: 'FORCE_ALLOW', reason: note }));
  authorization = allowed.dynamicAuthorization?.authorizationId;
  check('auditor overriding DENY creates reusable authorization', Boolean(authorization));
  const { request: repeated } = await search('insp.singh', 'record', 'REC-FIR-001');
  report.evidence.reusedRequestId = repeated.requestId;
  report.evidence.authorizationId = authorization;
  check('the next Search grants automatically by exact authorization', repeated.automatic === true);
  check('reuse creates no off-chain review and invokes no model worker',
    !fs.existsSync(path.join(DIAS_REVIEW_STORE_DIR, `${repeated.requestId}.json`)));
  const repeatTrail = await data(client.trail(repeated.requestId));
  check('reuse records MATCH, skipped auditor and GRANTED without a recommendation commitment',
    repeatTrail.summary.dynamicAuthorization.outcome === 'MATCH'
    && repeatTrail.summary.outcome.outcome === 'GRANTED' && repeatTrail.recommendationCommitment === null
    && repeatTrail.lifecycle.some((e) => e.eventType === 'AUDITOR_REVIEW_SKIPPED'));

  const evidenceId = `EV-PORTAL-${Date.now()}`;
  await data(post('/records/REC-FIR-001/evidence', 'analyst.rao', {
    evidenceId, artifact: 'Synthetic engineering fixture; no real evidence.', source: 'portal-workflow-test',
    detail: 'Synthetic fixture for identifier discovery only.',
  }));
  const entries = await apiFor('const.verma').records.evidenceIndex(evidenceId);
  check('evidence discovery reveals only identifier and parent file ownership', entries.length === 1
    && entries[0].recordId === 'REC-FIR-001' && !entries[0].evidenceHash && !entries[0].detail);
  const { request: evidenceRequest } = await search('const.verma', 'evidence', evidenceId);
  report.evidence.evidenceId = evidenceId;
  report.evidence.evidenceRequestId = evidenceRequest.requestId;
  check('Search for evidence automatically requests its parent file scope', evidenceRequest.recordId === 'REC-FIR-001');
  const cancelled = await data(post(`/access/request/${evidenceRequest.requestId}/cancel`, 'const.verma', {}));
  check('cancellation closes without granting access', cancelled.request.status === 'cancelled');

  const log = (await data(get('/access/workflow-log?limit=100', 'sp.north'))).entries;
  const reused = log.find((r) => r.requestId === repeated.requestId);
  const settled = log.find((r) => r.requestId === denied.requestId);
  check('workflow log distinguishes advice, final decision, approval and automatic authorization',
    settled.decision === 'FORCE_DENY' && settled.outcome === 'DENIED' && settled.llmRecommendation
    && reused.outcome === 'GRANTED' && reused.basis === 'DYNAMIC_AUTHORIZATION'
    && reused.llmRecommendation === null && reused.dynamicAuthorizationCheck.outcome === 'MATCH');
  let searchLogged = false;
  for (let n = 0; n < 20 && !searchLogged; n += 1) {
    const events = (await data(get('/audit/access-log?limit=100', 'sp.north'))).entries;
    searchLogged = events.some((e) => e.action === 'record.search' && e.target?.filters?.evidenceId === evidenceId);
    if (!searchLogged) await sleep(1000);
  }
  check('evidence Search is committed in the application blockchain access log', searchLogged);
}

run().catch((error) => { report.error = error.message; console.error(error.message); }).finally(async () => {
  if (authorization) {
    try {
      const revoked = await post(`/access/dynamic-authorizations/${authorization}/revoke`, 'sp.north', { reason: note });
      check('temporary test authorization is revoked', revoked.status === 200, { authorizationId: authorization });
    } catch (error) { report.cleanupError = error.message; check('temporary test authorization is revoked', false); }
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  report.summary = { passed: report.checks.length - failed, failed, error: report.error || null };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
  process.exitCode = failed || report.error ? 1 : 0;
});
