#!/usr/bin/env node
'use strict';

/**
 * The end-to-end experiment on the running Mac host: the workflows of a plan,
 * one at a time, in the plan's alternating order.
 *
 *   officer submits on the Mac -> the backend's LLM advises and the advice is
 *   committed -> the auditor reads the queue and opens the review -> the auditor
 *   decides and the decision is confirmed from the ledger -> the access log is read.
 *
 *   a `mac` workflow     the auditor's steps go through the Mac API, as the web portal does;
 *   a `mobile` workflow  the auditor's steps are made on the phone screen (Android emulator),
 *                        in one signed-in session that lasts the whole run.
 *
 * Two rules make the two kinds comparable:
 *   - they alternate, so both meet the same ledger size and background load;
 *   - every timed ledger write (the request, and the decision) is sent only when
 *     the ledger is quiet, so none of them rides on a block that a background
 *     access-log write happened to open. The waits are recorded and are not part
 *     of the processing time, like an auditor's reading time.
 *
 * The auditor is automated and follows the committed advice. The run writes
 * synthetic requests and decisions to the live ledger and nothing else: no seed,
 * no reset, no refused call on purpose, and no reusable authorization.
 *
 * usage: run.js --plan plan.json --out DIR --staging DIR [--limit N]
 *   --staging  the backend's access-event staging folder (<review store>/access-events)
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { digestOf } = require('./plan');
const {
  adviceDecision, checkTrail, createClient, endToEndMs, now, parseInstrumentation, referenceFor, round,
  sleep, stagedEvents, waitForQuiet, waitForRecommendation,
} = require('./lib');

const API = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const PHONE_API = process.env.DIAS_PHONE_API_URL || 'http://10.0.2.2:3001';
const ADB = process.env.ADB || path.join(process.env.HOME, 'Library/Android/sdk/platform-tools/adb');
const APP_ID = 'org.dias.mobile.dev';
const PHONE_TEST = 'org.dias.mobile.screen.EndToEndExperimentTest#theAuditorServesTheExperimentFromThePhone';
const RUNNER = `${APP_ID}.test/androidx.test.runner.AndroidJUnitRunner`;
/** A reader outside the reviewer set, for the reduced decision log every user sees. */
const ORDINARY_READER = 'clerk.das';
/** The contract returns at most this many entries of a log. */
const LOG_CAP = 500;

function options(argv) {
  const read = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  const parsed = { plan: read('plan'), out: read('out'), staging: read('staging'), limit: Number(read('limit', '0')) };
  if (!parsed.plan || !parsed.out || !parsed.staging) {
    throw new Error('usage: run.js --plan plan.json --out DIR --staging DIR [--limit N]');
  }
  return parsed;
}

const adb = (args, timeout = 30000) => new Promise((resolve) => {
  execFile(ADB, args, { timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => resolve({ error, stdout: stdout || '' }));
});

/** The auditor's phone: one instrumented session, commanded through small files in the app's own folder. */
function phoneSession(auditor) {
  const name = `run-${Date.now()}`;
  const folder = `cache/evidence/session-${name}`;
  let child = null;
  let output = '';
  let exited = null;
  let sent = 0;

  async function read(file, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      const result = await adb(['exec-out', 'run-as', APP_ID, 'cat', `${folder}/${file}`]);
      if (result.stdout.trim().startsWith('{')) return JSON.parse(result.stdout);
      if (exited !== null) throw new Error(`the phone session ended: ${parseInstrumentation(output).detail}`);
      if (now() > deadline) throw new Error(`no ${file} from the phone within ${timeoutMs} ms`);
      await sleep(120);
    }
  }

  return {
    async start() {
      child = spawn(ADB, ['shell', 'am', 'instrument', '-w', '-e', 'class', PHONE_TEST, '-e', 'apiBase', PHONE_API,
        '-e', 'reviewerUsername', auditor, '-e', 'experimentSession', name, RUNNER]);
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      exited = null;
      child.on('exit', (code) => { exited = code; });
      return read('ready.json', 60000);
    },
    /** Send one command and wait for its answer. An answer that carries an error is thrown. */
    async command(text, timeoutMs = 180000) {
      sent += 1;
      const file = `${folder}/cmd-${sent}`;
      await adb(['shell', 'run-as', APP_ID, 'sh', '-c', `'echo ${text} > ${file}.tmp && mv ${file}.tmp ${file}'`]);
      const answer = await read(`res-${sent}.json`, timeoutMs);
      if (answer.error) throw new Error(`phone: ${answer.error}`);
      return answer;
    },
    async stop() {
      if (!child || exited !== null) return parseInstrumentation(output);
      sent += 1;
      const file = `${folder}/cmd-${sent}`;
      await adb(['shell', 'run-as', APP_ID, 'sh', '-c', `'echo stop > ${file}.tmp && mv ${file}.tmp ${file}'`]);
      const deadline = now() + 30000;
      while (exited === null && now() < deadline) await sleep(200);
      if (exited === null) child.kill();
      return parseInstrumentation(output);
    },
  };
}

/** The Mac auditor: the calls the web portal's auditor screen makes, each timed. */
function macAuditor(client, auditor) {
  let review = null;
  return {
    async open(requestId) {
      const queue = await client.get('/access/auditor/pending', auditor);
      if (queue.status !== 200) throw new Error(`queue ${queue.status}: ${queue.error}`);
      review = await client.get(`/access/auditor/${requestId}`, auditor);
      if (review.status !== 200) throw new Error(`review ${review.status}: ${review.error}`);
      return { queueMs: round(queue.ms), reviewMs: round(review.ms), pendingShown: queue.data.length };
    },
    async decide(requestId) {
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
      const log = await client.get('/access/workflow-log?limit=100', auditor);
      const newest = log.status === 200 ? newestEntry(log.data.entries) : {};
      return {
        surface: 'mac-api', decisionMs: round(decided.ms), readbackMs: round(readback.ms), logMs: round(log.ms),
        followed: chosen.followed, decision: chosen.decision, outcome: outcome.outcome, outcomeId: outcome.outcomeId,
        readbackOk: readback.status === 200 && readback.data.outcomeId === outcome.outcomeId,
        logOk: newest.requestId === requestId && newest.decision === chosen.decision
          && newest.outcome === outcome.outcome && Boolean(newest.auditor) && newest.auditor.username === auditor,
      };
    },
  };
}

/** The newest entry as the access log orders it: by decision time, then by request number. */
function newestEntry(entries) {
  const time = (entry) => String(entry.decidedAtUtc || entry.submittedAtUtc);
  return [...entries].sort((a, b) => time(b).localeCompare(time(a)) || String(b.requestId).localeCompare(String(a.requestId)))[0] || {};
}

/** The phone auditor: the same two steps, made on the screen. Its decision time holds the readback. */
function phoneAuditor(phone) {
  return {
    async open(requestId) {
      const opened = await phone.command(`open ${requestId}`);
      return { queueMs: round(opened.queueMs), reviewMs: round(opened.reviewMs), pendingShown: opened.pendingShown };
    },
    async decide(requestId) {
      const decided = await phone.command(`decide ${requestId}`);
      if (decided.requestId !== requestId) throw new Error('the phone answered for another request');
      return {
        surface: 'phone-ui', decisionMs: round(decided.decisionMs), readbackMs: 0, logMs: round(decided.logMs),
        followed: decided.followed, decision: decided.decision, outcome: decided.outcome, outcomeId: decided.outcomeId,
        readbackOk: Boolean(decided.outcomeId),
        logOk: decided.logFirstRowIsThisRequest && decided.logShowsDecision && decided.logShowsOutcome,
      };
    },
  };
}

/** One workflow. It never throws: a failure is a row that names the stage it failed in. */
async function workflow({ client, item, auditor, auditors, quiet }) {
  const row = {
    id: item.id, config: item.config, username: item.username, recordId: item.recordId, action: item.action,
    purpose: item.purpose, auditor, status: 'failed', stage: 'submit', decisionSent: false,
  };
  try {
    row.quietBeforeRequestMs = round(await quiet());
    row.startedAtUtc = new Date().toISOString();
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

    row.stage = 'review';
    const desk = auditors[item.config];
    Object.assign(row, await desk.open(row.requestId));

    row.stage = 'decision';
    row.quietBeforeDecisionMs = round(await quiet());
    row.decisionSent = true;
    Object.assign(row, await desk.decide(row.requestId));
    row.endToEndMs = endToEndMs(row);
    row.status = 'decided';
    row.stage = 'done';
  } catch (error) {
    row.error = String(error.message || error);
  }
  row.finishedAtUtc = new Date().toISOString();
  return row;
}

/** After the run: every decided workflow is checked on the ledger and from the requester's side. */
async function verify({ client, row, auditor }) {
  const seen = await client.get(`/access/request/${row.requestId}`, row.username);
  row.requesterReadbackMs = round(seen.ms);
  row.requesterSees = seen.data ? seen.data.status : null;
  row.requesterOk = seen.status === 200 && String(row.requesterSees).toUpperCase() === row.outcome
    && seen.data.outcomeId === row.outcomeId;
  const trail = await client.get(`/audit/request-trail/${row.requestId}`, auditor);
  if (trail.status !== 200) {
    row.checks = [{ name: 'the request trail can be read', ok: false }];
    row.ledgerOk = false;
  } else {
    row.checks = checkTrail(trail.data, {
      requestId: row.requestId, decision: row.decision, auditor, outcomeId: row.outcomeId,
    });
    row.ledgerOk = row.checks.every((check) => check.ok);
    Object.assign(row, ledgerFacts(trail.data));
  }
  row.status = row.ledgerOk && row.requesterOk && row.logOk && row.readbackOk && row.pendingShown === 1
    ? 'completed' : 'check-failed';
  return row;
}

/** Times and advice as the ledger and the committed recommendation record them. */
function ledgerFacts(trail) {
  const commitment = trail.recommendationCommitment || {};
  const decision = trail.auditorDecision || {};
  const recommendation = (trail.offChainReview && trail.offChainReview.recommendation) || {};
  const provenance = recommendation.provenance || {};
  const reference = referenceFor(trail.request.verifiedRequest);
  const committed = commitment.generationStatus === 'OK' ? commitment.recommendation : null;
  return {
    advice: committed, generationStatus: commitment.generationStatus || null,
    llmAgreement: decision.llmAgreement || null,
    modelId: provenance.modelId || null, promptVersion: provenance.promptVersion || null,
    adapterId: provenance.adapterId || null,
    // The model's own inference time, as the backend measured and stored it.
    modelInferenceMs: provenance.latencyMs && Number.isFinite(provenance.latencyMs.inference)
      ? round(provenance.latencyMs.inference) : null,
    promptTokens: provenance.usage ? provenance.usage.promptTokens : null,
    completionTokens: provenance.usage ? provenance.usage.completionTokens : null,
    policyAnswer: reference.recommendation,
    adviceMatchesPolicy: committed ? committed === reference.recommendation : null,
    decisionTxId: decision.txId || null, commitmentTxId: commitment.txId || null, requestTxId: trail.request.txId,
  };
}

/** The logs every kind of user reads must hold all of the run. No check passes on an empty run. */
async function endChecks({ client, rows, auditor, decisionsBefore, sinceUtc }) {
  const done = rows.filter((row) => row.requestId && row.outcomeId);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok) && done.length > 0, detail });

  const events = await client.get(`/audit/access-log?limit=${LOG_CAP}`, auditor);
  const opened = new Set((events.data ? events.data.entries : [])
    .filter((event) => event.action === 'dias.auditor.review.read' && event.actorUsername === auditor && event.outcome === 'ok')
    .map((event) => event.target && event.target.requestId));
  const found = done.filter((row) => opened.has(row.requestId)).length;
  check('every auditor review is in the searches-and-reads log on the ledger', found === done.length,
    `${found} of ${done.length} found`);
  const refused = (events.data ? events.data.entries : []).filter((event) => event.outcome !== 'ok'
    && event.timestamp >= sinceUtc).length;
  check('the run caused no refused or failed call', events.status === 200 && refused === 0, `${refused} since the run began`);

  const reduced = await client.get(`/access/decision-log?limit=${LOG_CAP}`, ORDINARY_READER);
  const entries = reduced.data ? reduced.data.entries : [];
  const expected = decisionsBefore + done.length;
  if (expected < LOG_CAP) {
    check('the reduced decision log an ordinary user reads grew by one entry per workflow',
      reduced.status === 200 && entries.length === expected, `${decisionsBefore} -> ${entries.length}, ${done.length} workflows`);
  }
  check('that reduced log shows no name or case file', entries.length > 0 && entries.every((entry) => entry.redacted === true
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
  if (digestOf(plan) !== plan.sha256) throw new Error('the plan does not match its own digest');
  const byId = new Map(plan.items.map((item) => [item.id, item]));
  const items = plan.order.map((id) => byId.get(id)).slice(0, opts.limit || undefined);
  const auditor = plan.auditor;
  fs.mkdirSync(opts.out, { recursive: true });
  const rowsFile = path.join(opts.out, 'rows.jsonl');
  if (fs.existsSync(rowsFile)) throw new Error(`${rowsFile} exists: a run is never written over an earlier one`);
  const client = createClient(API);
  const quiet = () => waitForQuiet({ list: stagedEvents(opts.staging) });

  const pending = await client.get('/access/auditor/pending', auditor);
  const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
  if (pending.status !== 200 || active.status !== 200 || pending.data.length !== 0 || active.data.length !== 0) {
    throw new Error('the host is not idle: a request is waiting or an authorization is active');
  }
  const before = await client.get(`/access/decision-log?limit=${LOG_CAP}`, ORDINARY_READER);
  const meta = {
    schema: 'dias-e2e-run-v2', planSha256: plan.sha256, planned: items.length, auditor,
    order: items.map((item) => item.id), startedAtUtc: new Date().toISOString(), environment: environment(),
    decisionsBefore: before.data.entries.length, staging: opts.staging,
  };
  fs.writeFileSync(path.join(opts.out, 'run.json'), `${JSON.stringify(meta, null, 1)}\n`);

  const phone = items.some((item) => item.config === 'mobile') ? phoneSession(auditor) : null;
  const rows = [];
  let phoneVerdict = null;
  try {
    if (phone) meta.phoneSignInMs = round((await phone.start()).signInMs);
    const auditors = { mac: macAuditor(client, auditor), mobile: phone && phoneAuditor(phone) };
    for (const item of items) {
      const row = await workflow({ client, item, auditor, auditors, quiet });
      rows.push(row);
      fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      console.log(`${row.id} ${row.status} ${row.requestId || '-'} outcome=${row.outcome || '-'} `
        + `e2e=${row.endToEndMs == null ? '-' : `${(row.endToEndMs / 1000).toFixed(1)}s`}${row.error ? ` ERROR at ${row.stage}: ${row.error}` : ''}`);
      if (row.status === 'failed') {
        console.error(row.decisionSent
          ? 'stopping: a decision was sent and not confirmed; read the request before anything else is done'
          : 'stopping: a workflow failed before its decision was sent');
        break;
      }
    }
  } finally {
    if (phone) phoneVerdict = await phone.stop();
  }

  for (const row of rows.filter((entry) => entry.status === 'decided')) await verify({ client, row, auditor });
  fs.writeFileSync(rowsFile, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  // The verification reads are logged as well. The backend writes them to the ledger one
  // at a time, so wait until all of them are there before the logs are checked.
  await waitForQuiet({ list: stagedEvents(opts.staging), timeoutMs: 20 * 60000 });
  const checks = await endChecks({
    client, rows, auditor, decisionsBefore: meta.decisionsBefore, sinceUtc: meta.startedAtUtc,
  });
  if (phone) checks.push({ name: 'the phone session ended cleanly', ok: phoneVerdict.ok, detail: phoneVerdict.detail });
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const completed = rows.filter((row) => row.status === 'completed').length;
  fs.writeFileSync(path.join(opts.out, 'run.json'), `${JSON.stringify({
    ...meta, finishedAtUtc: new Date().toISOString(), ran: rows.length, completed, failed: rows.length - completed, endChecks: checks,
  }, null, 1)}\n`);
  console.log(`${completed} of ${rows.length} workflows completed and verified (${items.length} planned)`);
  process.exitCode = completed === items.length && checks.every((check) => check.ok) ? 0 : 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
