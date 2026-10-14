#!/usr/bin/env node
'use strict';

/**
 * One half of the end-to-end experiment on the running Mac host, one workflow at
 * a time (closed loop):
 *
 *   officer submits on the Mac -> the backend's LLM advises and the advice is
 *   committed -> the auditor reads the queue, opens the review and decides ->
 *   the decision is confirmed from the ledger -> the access log is read.
 *
 *   --config mac     the auditor's steps go through the Mac API, as the web portal does;
 *   --config mobile  the auditor's steps are made on the phone screen (Android emulator).
 *
 * The auditor is automated and follows the committed advice at once, so no time
 * here is human thinking time. Every workflow is then checked on the ledger. It
 * writes synthetic requests and decisions to the live ledger and nothing else:
 * no seed, no reset, and no reusable authorization (following the advice never
 * creates one).
 *
 * usage: run.js --config mac|mobile --plan plan.json --out DIR [--limit N] [--pause-ms 2000]
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const {
  adviceDecision, checkTrail, createClient, endToEndMs, now, parseInstrumentation, referenceFor, round,
  sleep, waitForRecommendation,
} = require('./lib');

const API = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const PHONE_API = process.env.DIAS_PHONE_API_URL || 'http://10.0.2.2:3001';
const ADB = process.env.ADB || path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const APP_ID = 'org.dias.mobile.dev';
const PHONE_TEST = 'org.dias.mobile.screen.EndToEndExperimentTest#theAuditorFollowsTheAdviceOnThePhone';
const RUNNER = `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;
/** A reader outside the reviewer set, for the reduced decision log every user sees. */
const ORDINARY_READER = 'clerk.das';

function options(argv) {
  const read = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  const parsed = {
    config: read('config'), plan: read('plan'), out: read('out'),
    limit: Number(read('limit', '0')), pauseMs: Number(read('pause-ms', '2000')),
  };
  if (!['mac', 'mobile'].includes(parsed.config) || !parsed.plan || !parsed.out) {
    throw new Error('usage: run.js --config mac|mobile --plan plan.json --out DIR [--limit N] [--pause-ms 2000]');
  }
  return parsed;
}

const run = (file, args, timeout = 240000) => new Promise((resolve) => {
  execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});

/** The auditor's steps through the Mac API: the calls the web portal's auditor screen makes. */
async function decideOnMac({ client, requestId, auditor }) {
  const queue = await client.get('/access/auditor/pending', auditor);
  if (queue.status !== 200) throw new Error(`queue ${queue.status}: ${queue.error}`);
  if (!queue.data.some((entry) => entry.request.requestId === requestId)) throw new Error('request missing from the auditor queue');
  const review = await client.get(`/access/auditor/${requestId}`, auditor);
  if (review.status !== 200) throw new Error(`review ${review.status}: ${review.error}`);
  const commitment = review.data.commitment || {};
  const chosen = adviceDecision({
    recommendationState: review.data.recommendationState,
    integrity: review.data.integrity && review.data.integrity.status,
    generationStatus: commitment.generationStatus, recommendation: commitment.recommendation,
  });
  const decided = await client.post(`/access/auditor/${requestId}/decision`, auditor,
    { decision: chosen.decision, reason: chosen.reason || '' });
  if (decided.status !== 201) throw new Error(`decision ${decided.status}: ${decided.error}`);
  const outcome = decided.data.accessOutcome || {};
  // The auditor's screen reads the request back before it shows the result as confirmed.
  const readback = await client.get(`/access/request/${requestId}`, auditor);
  if (readback.status !== 200 || readback.data.outcomeId !== outcome.outcomeId) throw new Error('auditor readback does not match the decision');
  const log = await client.get('/access/workflow-log?limit=100', auditor);
  if (log.status !== 200) throw new Error(`access log ${log.status}: ${log.error}`);
  const newest = [...log.data.entries].sort((a, b) => String(b.decidedAtUtc || b.submittedAtUtc)
    .localeCompare(String(a.decidedAtUtc || a.submittedAtUtc)))[0] || {};
  return {
    surface: 'mac-api', pendingShown: queue.data.length,
    queueMs: round(queue.ms), reviewMs: round(review.ms), decisionMs: round(decided.ms),
    readbackMs: round(readback.ms), logMs: round(log.ms),
    advice: commitment.recommendation || null, followed: chosen.followed,
    decision: chosen.decision, outcome: outcome.outcome, outcomeId: outcome.outcomeId,
    logOk: newest.requestId === requestId && newest.decision === chosen.decision
      && newest.outcome === outcome.outcome && Boolean(newest.auditor) && newest.auditor.username === auditor,
  };
}

/** The auditor's steps on the phone screen. Its decision time already holds the readback. */
async function decideOnPhone({ requestId, auditor }) {
  const startedAt = now();
  const result = await run(ADB, ['shell', 'am', 'instrument', '-w', '-e', 'class', PHONE_TEST, '-e', 'apiBase', PHONE_API,
    '-e', 'reviewerUsername', auditor, '-e', 'experimentRequestId', requestId, RUNNER]);
  const wallMs = now() - startedAt;
  const verdict = parseInstrumentation(result.stdout);
  if (!verdict.ok) throw new Error(`phone: ${verdict.detail}`);
  const saved = await run(ADB, ['exec-out', 'run-as', APP_ID, 'cat', `cache/evidence/e2e-${requestId}.json`], 30000);
  const phone = JSON.parse(saved.stdout);
  if (phone.requestId !== requestId) throw new Error('phone result belongs to another request');
  return {
    surface: 'phone-ui', pendingShown: phone.pendingShown,
    queueMs: round(phone.queueMs), reviewMs: round(phone.reviewMs), decisionMs: round(phone.decisionMs),
    readbackMs: 0, logMs: round(phone.logMs), phoneSignInMs: round(phone.signInMs),
    phoneRunWallMs: round(wallMs),
    advice: phone.advice, followed: phone.followed, decision: phone.decision,
    outcome: phone.outcome, outcomeId: phone.outcomeId,
    logOk: phone.logFirstRowIsThisRequest && phone.logShowsDecision && phone.logShowsOutcome,
  };
}

/** One workflow. It never throws: a failure is a row that names the stage it failed in. */
async function workflow({ client, item, auditor, config }) {
  const row = {
    id: item.id, config, username: item.username, recordId: item.recordId, action: item.action,
    purpose: item.purpose, auditor, status: 'failed', stage: 'submit', startedAtUtc: new Date().toISOString(),
  };
  try {
    const submitted = await client.post('/access/request', item.username, {
      recordId: item.recordId, action: item.action, purpose: item.purpose, justification: item.justification,
    });
    row.submitStatus = submitted.status;
    row.submitMs = round(submitted.ms);
    if (submitted.status !== 202 || !submitted.data || !submitted.data.requestId) {
      throw new Error(`submit ${submitted.status}: ${submitted.error || (submitted.data && submitted.data.message)}`);
    }
    row.requestId = submitted.data.requestId;

    row.stage = 'recommendation';
    row.recommendationMs = round(await waitForRecommendation(client, row.requestId, auditor));

    row.stage = 'auditor';
    Object.assign(row, await (config === 'mac' ? decideOnMac : decideOnPhone)({ client, requestId: row.requestId, auditor }));
    row.endToEndMs = endToEndMs(row);

    row.stage = 'verify';
    const seen = await client.get(`/access/request/${row.requestId}`, item.username);
    row.requesterReadbackMs = round(seen.ms);
    row.requesterSees = seen.data ? seen.data.status : null;
    row.requesterOk = seen.status === 200 && String(row.requesterSees).toUpperCase() === row.outcome
      && seen.data.outcomeId === row.outcomeId;
    const trail = await client.get(`/audit/request-trail/${row.requestId}`, auditor);
    if (trail.status !== 200) throw new Error(`trail ${trail.status}: ${trail.error}`);
    row.checks = checkTrail(trail.data, {
      requestId: row.requestId, decision: row.decision, auditor, outcomeId: row.outcomeId,
    });
    row.ledgerOk = row.checks.every((check) => check.ok);
    Object.assign(row, ledgerFacts(trail.data));
    row.status = row.ledgerOk && row.requesterOk && row.logOk && row.pendingShown === 1 ? 'completed' : 'check-failed';
    row.stage = 'done';
  } catch (error) {
    row.error = String(error.message || error);
  }
  row.finishedAtUtc = new Date().toISOString();
  return row;
}

/** Times and advice as the ledger and the committed recommendation record them. */
function ledgerFacts(trail) {
  const commitment = trail.recommendationCommitment || {};
  const decision = trail.auditorDecision || {};
  const recommendation = (trail.offChainReview && trail.offChainReview.recommendation) || {};
  const provenance = recommendation.provenance || {};
  const between = (from, to) => (from && to ? Date.parse(to) - Date.parse(from) : null);
  const reference = referenceFor(trail.request.verifiedRequest);
  const committed = commitment.generationStatus === 'OK' ? commitment.recommendation : null;
  return {
    recommendation: committed, generationStatus: commitment.generationStatus || null,
    llmAgreement: decision.llmAgreement || null,
    modelId: provenance.modelId || null, promptVersion: provenance.promptVersion || null,
    adapterId: provenance.adapterId || null,
    // The model's own inference time, as the backend measured and stored it.
    modelInferenceMs: provenance.latencyMs && Number.isFinite(provenance.latencyMs.inference)
      ? round(provenance.latencyMs.inference) : null,
    promptTokens: provenance.usage ? provenance.usage.promptTokens : null,
    completionTokens: provenance.usage ? provenance.usage.completionTokens : null,
    ledgerSubmitToCommitmentMs: between(trail.request.submittedAtUtc, commitment.committedAtUtc),
    ledgerCommitmentToDecisionMs: between(commitment.committedAtUtc, decision.decidedAtUtc),
    policyAnswer: reference.recommendation,
    adviceMatchesPolicy: committed ? committed === reference.recommendation : false,
    decisionTxId: decision.txId || null, commitmentTxId: commitment.txId || null, requestTxId: trail.request.txId,
  };
}

/** After the run: the logs every kind of user reads must hold all of it. */
async function endChecks({ client, rows, auditor, decisionsBefore }) {
  const done = rows.filter((row) => row.requestId && row.outcomeId);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  // Application access events are written to the ledger after the response, so wait for them.
  let missing = done.map((row) => row.requestId);
  const deadline = now() + 120000;
  for (;;) {
    const events = await client.get('/audit/access-log?limit=500', auditor);
    const opened = new Set((events.data ? events.data.entries : [])
      .filter((event) => event.action === 'dias.auditor.review.read' && event.actorUsername === auditor && event.outcome === 'ok')
      .map((event) => event.target && event.target.requestId));
    missing = done.map((row) => row.requestId).filter((requestId) => !opened.has(requestId));
    if (missing.length === 0 || now() > deadline) break;
    await sleep(3000);
  }
  check('every auditor review is in the searches-and-reads log on the ledger', missing.length === 0,
    `${done.length - missing.length} of ${done.length} found`);

  const reduced = await client.get('/access/decision-log?limit=500', ORDINARY_READER);
  const entries = reduced.data ? reduced.data.entries : [];
  check('the reduced decision log an ordinary user reads grew by one entry per workflow',
    entries.length === decisionsBefore + done.length, `${decisionsBefore} -> ${entries.length}, ${done.length} workflows`);
  check('that reduced log shows no name or case file', entries.every((entry) => entry.redacted === true
    && !entry.requestId && !entry.recordId && !(entry.requester && entry.requester.username)), `${entries.length} entries`);

  const byRequester = new Map();
  done.forEach((row) => byRequester.set(row.username, [...(byRequester.get(row.username) || []), row]));
  let ownOk = 0;
  for (const [username, own] of byRequester) {
    const mine = await client.get('/access/requests/mine?limit=100', username);
    const status = new Map((mine.data ? mine.data.entries : []).map((entry) => [entry.requestId, entry.status]));
    if (own.every((row) => String(status.get(row.requestId)).toUpperCase() === row.outcome)) ownOk += 1;
  }
  check('each requester finds their own requests with the final outcome', ownOk === byRequester.size,
    `${ownOk} of ${byRequester.size} requesters`);

  const pending = await client.get('/access/auditor/pending', auditor);
  check('no request is left waiting for an auditor', pending.status === 200 && pending.data.length === 0,
    `${pending.data ? pending.data.length : '?'} waiting`);
  const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
  check('no reusable authorization was created', active.status === 200 && active.data.length === 0,
    `${active.data ? active.data.length : '?'} active`);
  return checks;
}

function environment() {
  const text = (file, args) => { try { return execFileSync(file, args, { encoding: 'utf8' }).trim(); } catch (_) { return null; } };
  return {
    api: API, node: process.version,
    gitHead: text('git', ['rev-parse', 'HEAD']),
    gitUncommittedEntries: (text('git', ['status', '--short']) || '').split('\n').filter(Boolean).length,
    chaincode: (text('docker', ['ps', '--format', '{{.Names}}']) || '').split('\n')
      .filter((name) => name.startsWith('dev-peer')).map((name) => name.split('-').slice(2).join('-').slice(0, 32)).sort()[0] || null,
  };
}

async function main() {
  const opts = options(process.argv.slice(2));
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  const items = plan.items.filter((item) => item.config === opts.config).slice(0, opts.limit || undefined);
  const auditor = plan.auditor;
  fs.mkdirSync(opts.out, { recursive: true });
  const rowsFile = path.join(opts.out, 'rows.jsonl');
  if (fs.existsSync(rowsFile)) throw new Error(`${rowsFile} exists: a run is never written over an earlier one`);
  const client = createClient(API);

  const pending = await client.get('/access/auditor/pending', auditor);
  const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
  if (pending.data.length !== 0 || active.data.length !== 0) {
    throw new Error(`the host is not idle: ${pending.data.length} waiting, ${active.data.length} active authorizations`);
  }
  if (opts.config === 'mobile') {
    const listed = await run(ADB, ['shell', 'pm', 'list', 'instrumentation'], 30000);
    if (!String(listed.stdout).includes(RUNNER)) throw new Error('the phone app and its test package are not installed');
  }
  const before = await client.get('/access/decision-log?limit=500', ORDINARY_READER);
  const meta = {
    schema: 'dias-e2e-run-v1', config: opts.config, planSha256: plan.sha256, planned: items.length, auditor,
    pauseMs: opts.pauseMs, startedAtUtc: new Date().toISOString(), environment: environment(),
    decisionsBefore: before.data.entries.length,
  };
  fs.writeFileSync(path.join(opts.out, 'run.json'), `${JSON.stringify(meta, null, 1)}\n`);

  const rows = [];
  for (const item of items) {
    const row = await workflow({ client, item, auditor, config: opts.config });
    rows.push(row);
    fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
    console.log(`${row.id} ${row.status} ${row.requestId || '-'} advice=${row.advice || '-'} outcome=${row.outcome || '-'} `
      + `e2e=${row.endToEndMs == null ? '-' : (row.endToEndMs / 1000).toFixed(1) + 's'}${row.error ? ` ERROR ${row.error}` : ''}`);
    if (row.status === 'failed' && row.stage !== 'verify') {
      // A request may be left waiting; stop rather than pile more requests behind it.
      console.error('stopping: a workflow failed before its decision was confirmed');
      break;
    }
    await sleep(opts.pauseMs);
  }

  const checks = await endChecks({ client, rows, auditor, decisionsBefore: meta.decisionsBefore });
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const completed = rows.filter((row) => row.status === 'completed').length;
  const summary = {
    ...meta, finishedAtUtc: new Date().toISOString(), ran: rows.length, completed,
    failed: rows.length - completed, endChecks: checks,
  };
  fs.writeFileSync(path.join(opts.out, 'run.json'), `${JSON.stringify(summary, null, 1)}\n`);
  console.log(`${completed} of ${rows.length} workflows completed and verified (${items.length} planned)`);
  process.exitCode = completed === items.length && checks.every((check) => check.ok) ? 0 : 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
