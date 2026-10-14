'use strict';

/**
 * What the three runners of the three-setup experiment share: the run folder, the desks, one reviewed
 * workflow from the officer's request to the officer reading the outcome, and the ledger checks made
 * afterwards.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  checkTrail, createClient, endToEndMs, referenceFor, round, stagedEvents, waitForQuiet, waitForRecommendation,
} = require('./lib');
const { macAuditor, macOfficer, phoneAuditor, phoneOfficer, phoneSession } = require('./desks');

const API = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const OFFICER_PHONE = process.env.DIAS_OFFICER_PHONE || 'emulator-5556';
const AUDITOR_PHONE = process.env.DIAS_AUDITOR_PHONE || 'emulator-5558';
/** An officer outside the reviewer set, for what every ordinary user reads. */
const ORDINARY_READER = 'clerk.das';
/** The contract returns at most this many entries of a log. */
const LOG_CAP = 500;

/**
 * `--name value` options; every name in `required` must be given. `--limit N` runs the first N entries of
 * the plan's order, `--only ID,ID` just those: both are for trial runs, a full run uses neither.
 */
function options(argv, required, usage) {
  const read = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const parsed = {
    plan: read('plan'), out: read('out'), staging: read('staging'), limit: Number(read('limit') || 0),
    only: read('only') ? read('only').split(',') : null,
  };
  if (required.some((name) => !parsed[name])) throw new Error(usage);
  return parsed;
}

/** The entries a run takes from the plan's order, after `--only` and `--limit`. */
const selected = (entries, opts) => entries
  .filter((entry) => !opts.only || opts.only.includes(entry.id)).slice(0, opts.limit || undefined);

/** When the backend stored and last rewrote the review of each request, taken from its own file writes. */
function storeWatcher(dir, { pollMs = 10 } = {}) {
  const isReview = (name) => /^REQ-[A-Za-z0-9._-]+\.json$/.test(name);
  const known = new Set(fs.readdirSync(dir).filter(isReview));
  const created = new Map();
  let timer = null;
  const scan = () => {
    for (const name of fs.readdirSync(dir)) {
      if (known.has(name) || !isReview(name)) continue;
      try {
        created.set(name.slice(0, -'.json'.length), fs.statSync(path.join(dir, name)).mtimeMs);
        known.add(name);
      } catch (_) { /* Replaced between the listing and the read; seen again on the next scan */ }
    }
  };
  return {
    start() { if (!timer) timer = setInterval(scan, pollMs); },
    stop() { clearInterval(timer); timer = null; },
    createdAt(requestId) { scan(); return created.has(requestId) ? created.get(requestId) : null; },
    writtenAt: (requestId) => fs.statSync(path.join(dir, `${requestId}.json`)).mtimeMs,
  };
}

/** From the review being stored to its recommendation being committed, by the backend's own writes. */
async function recommendationTime({ client, watcher, requestId, auditor }) {
  await waitForRecommendation(client, requestId, auditor);
  const created = watcher.createdAt(requestId);
  if (created === null) throw new Error('the review of this request was never seen being stored');
  return watcher.writtenAt(requestId) - created;
}

function environment() {
  const text = (file, args) => { try { return execFileSync(file, args, { encoding: 'utf8' }).trim(); } catch (_) { return null; } };
  return {
    api: API, node: process.version, officerPhone: OFFICER_PHONE, auditorPhone: AUDITOR_PHONE,
    gitHead: text('git', ['rev-parse', 'HEAD']),
    gitUncommittedEntries: (text('git', ['status', '--short']) || '').split('\n').filter(Boolean).length,
    chaincodeContainers: (text('docker', ['ps', '--format', '{{.Names}}']) || '').split('\n')
      .filter((name) => name.startsWith('dev-peer')).map((name) => name.split('-').slice(2).join('-').slice(0, 40)).sort(),
  };
}

/** A run starts only on an idle host: nothing waiting for an auditor and no authorization active. */
async function requireIdleHost(client, auditor) {
  const pending = await client.get('/access/auditor/pending', auditor);
  const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
  if (pending.status !== 200 || active.status !== 200) throw new Error('the host could not be read as the auditor');
  if (pending.data.length !== 0 || active.data.length !== 0) {
    throw new Error(`the host is not idle: ${pending.data.length} waiting, ${active.data.length} authorizations active`);
  }
}

/** The run folder and its row file. A run is never written over an earlier one. */
function openRun(out) {
  fs.mkdirSync(out, { recursive: true });
  const rowsFile = path.join(out, 'rows.jsonl');
  if (fs.existsSync(rowsFile)) throw new Error(`${rowsFile} exists: a run is never written over an earlier one`);
  return {
    rowsFile,
    append: (row) => fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`),
    rewrite: (rows) => fs.writeFileSync(rowsFile, rows.map((row) => `${JSON.stringify(row)}\n`).join('')),
    meta: (content) => fs.writeFileSync(path.join(out, 'run.json'), `${JSON.stringify(content, null, 1)}\n`),
  };
}

/**
 * The desks of one run. Every officer is signed in on the Mac first, so no sign-in falls inside a timed
 * step.
 */
async function openDesks({ client, auditor, officers, officerPhone, auditorPhone }) {
  for (const username of [auditor, ORDINARY_READER, ...officers]) await client.login(username);
  const phones = {};
  if (auditorPhone) phones.auditor = phoneSession({ serial: AUDITOR_PHONE, username: auditor, label: 'auditor-phone' });
  if (officerPhone) phones.officer = phoneSession({ serial: OFFICER_PHONE, username: officers[0], label: 'officer-phone' });
  const started = {};
  for (const [role, phone] of Object.entries(phones)) started[role] = round((await phone.start()).signInMs);
  return {
    phoneSignInMs: started,
    officers: { mac: macOfficer(client), phone: phones.officer ? phoneOfficer(phones.officer, officers[0]) : null },
    auditors: { mac: macAuditor(client, auditor), phone: phones.auditor ? phoneAuditor(phones.auditor) : null },
    /** End the phone sessions; returns one check per phone. */
    async close() {
      const checks = [];
      for (const [role, phone] of Object.entries(phones)) {
        const verdict = await phone.stop();
        checks.push({ name: `the ${role}'s phone session ended cleanly`, ok: verdict.ok, detail: verdict.detail });
      }
      return checks;
    },
  };
}

/**
 * One reviewed workflow: the officer submits, the backend's LLM advises and the advice is committed, the
 * auditor reads the queue, opens the review and decides, and the officer reads the outcome.
 */
async function reviewedWorkflow({ client, watcher, item, auditor, officerDesk, auditorDesk, quiet, mode = 'follow',
  overrideReason = '', whileWaiting = null }) {
  const row = {
    id: item.id, username: item.username, recordId: item.recordId, action: item.action, purpose: item.purpose,
    auditor, officerSurface: officerDesk.surface, auditorSurface: auditorDesk.surface,
    status: 'failed', stage: 'prepare', decisionSent: false,
  };
  try {
    Object.assign(row, await officerDesk.prepare(item.username));
    row.stage = 'submit';
    row.quietBeforeRequestMs = round(await quiet());
    row.startedAtUtc = new Date().toISOString();
    Object.assign(row, await officerDesk.submit(item));
    if (row.automatic) throw new Error('a reusable authorization granted this request; a review was expected');

    row.stage = 'recommendation';
    row.recommendationMs = round(await recommendationTime({ client, watcher, requestId: row.requestId, auditor }));

    row.stage = 'review';
    Object.assign(row, await auditorDesk.open(row.requestId));
    if (whileWaiting) Object.assign(row, await whileWaiting(row));

    row.stage = 'decision';
    row.quietBeforeDecisionMs = round(await quiet());
    row.overridden = mode === 'override' && row.adviceShown === 'DENY';
    row.decisionSent = true;
    Object.assign(row, row.overridden
      ? await auditorDesk.override(row.requestId, overrideReason) : await auditorDesk.decide(row.requestId));
    row.endToEndMs = endToEndMs(row);

    row.stage = 'outcome';
    Object.assign(row, await officerDesk.outcome(item, row.requestId));
    row.status = 'decided';
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
    createdAuthorizationId: decision.createdAuthorizationId || null,
  };
}

/**
 * What the officer must have been shown: the outcome, and the LLM's explanation only after a denial with
 * advice.
 */
function officerViewOk(row) {
  const explained = row.outcome === 'DENIED' && row.advice !== null;
  return row.officerSees === row.outcome && row.explanationShown === explained;
}

/** After the timed part: one decided workflow is checked on the ledger. */
async function verifyReviewed({ client, row, auditor }) {
  const trail = await client.get(`/audit/request-trail/${row.requestId}`, auditor);
  if (trail.status !== 200) {
    row.checks = [{ name: 'the request trail can be read', ok: false }];
    row.ledgerOk = false;
  } else {
    row.checks = checkTrail(trail.data, {
      requestId: row.requestId, decision: row.decision, auditor, outcomeId: row.outcomeId,
      createdAuthorizationId: row.overridden ? row.authorizationId : undefined,
    });
    row.ledgerOk = row.checks.every((check) => check.ok);
    Object.assign(row, ledgerFacts(trail.data));
  }
  row.officerOk = row.ledgerOk && officerViewOk(row);
  row.status = row.ledgerOk && row.officerOk && row.logOk !== false && row.readbackOk ? 'completed' : 'check-failed';
  return row;
}

/**
 * The searches-and-reads log of the ledger for the workflows just run: every auditor review is in it, and
 * nothing was refused or failed.
 */
async function eventsCheck({ client, auditor, rows, sinceUtc, label }) {
  const events = await client.get(`/audit/access-log?limit=${LOG_CAP}`, auditor);
  const entries = events.status === 200 ? events.data.entries : [];
  const opened = new Set(entries
    .filter((event) => event.action === 'dias.auditor.review.read' && event.actorUsername === auditor && event.outcome === 'ok')
    .map((event) => event.target && event.target.requestId));
  const reviewed = rows.filter((row) => row.requestId && row.queueMs !== undefined);
  const found = reviewed.filter((row) => opened.has(row.requestId)).length;
  const refused = entries.filter((event) => event.outcome !== 'ok' && event.timestamp >= sinceUtc);
  return [
    { name: `${label}: every auditor review is in the searches-and-reads log on the ledger`,
      ok: events.status === 200 && reviewed.length > 0 && found === reviewed.length, detail: `${found} of ${reviewed.length} found` },
    { name: `${label}: no call was refused or failed`,
      ok: events.status === 200 && refused.length === 0,
      detail: refused.length === 0 ? '0 since the run began'
        : refused.slice(0, 3).map((event) => `${event.actorUsername} ${event.action} ${event.outcome}`).join('; ') },
  ];
}

/** What is left on the host after a run: nothing waiting, and no authorization active. */
async function hostLeftIdle({ client, auditor }) {
  const pending = await client.get('/access/auditor/pending', auditor);
  const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
  return [
    { name: 'no request is left waiting for an auditor', ok: pending.status === 200 && pending.data.length === 0,
      detail: `${pending.data ? pending.data.length : '?'} waiting` },
    { name: 'no reusable authorization is left active', ok: active.status === 200 && active.data.length === 0,
      detail: `${active.data ? active.data.length : '?'} active` },
  ];
}

const quietOn = (staging, timeoutMs) => () => waitForQuiet({ list: stagedEvents(staging), ...(timeoutMs ? { timeoutMs } : {}) });

module.exports = {
  API, LOG_CAP, ORDINARY_READER, createClient, environment, eventsCheck, hostLeftIdle, ledgerFacts, officerViewOk,
  openDesks, openRun, options, quietOn, recommendationTime, requireIdleHost, reviewedWorkflow, selected,
  storeWatcher, verifyReviewed,
};
