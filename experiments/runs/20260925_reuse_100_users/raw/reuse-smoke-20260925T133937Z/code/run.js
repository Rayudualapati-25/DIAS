#!/usr/bin/env node
'use strict';

/**
 * The reuse experiment: the rounds of a reuse plan through the live backend,
 * with the scripted fixed-approval auditor.
 *
 * In each round all users start together, and each user sends its three
 * requests one after another in the plan's order for that round. A request that
 * matches an active exact-record authorization is granted by the contract at once
 * (HTTP 201: no model, no auditor). Any other request waits for the model's
 * recommendation and the auditor's decision. The auditor commits FORCE_ALLOW over
 * a model DENY only for an approved base request (which creates the
 * authorization), otherwise follows the model, and denies an unusable
 * recommendation. The next round starts only after every request of the round is
 * decided and a cool-down has passed, so a repeat never overtakes the decision on
 * its own first request. Times contain no human review time.
 *
 * Usage: node testbed/reuse/run.js --plan testbed/reuse/generated/reuse-100-users-plan.json \
 *          --url http://dias-backend:3001/api --review-dir /data/dias-reviews --out /results/<run>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  AUDITORS, createClient, createWatcher, now, referenceFor, round, sleep,
} = require('../load/workflow');

const APP = path.resolve(__dirname, '..', '..');
const DEPARTMENT_HEAD = Object.freeze({
  police: 'sp.north', forensics: 'cfo.north', prosecution: 'dp.north', court: 'dj.north',
});
const OVERRIDE_REASON = 'Approved on review: the request is in the pre-registered approval set of the reuse experiment.';
const UNUSABLE_REASON = 'No valid LLM recommendation was available; denied pending manual review.';
const PROGRESS_EVERY = 50;

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

/** The district head of the requester's department; south-district files go to the south SP (as in E5-E7). */
function auditorFor(stream, user) {
  return stream.record.jurisdiction === 'district-south' ? 'sp.south' : DEPARTMENT_HEAD[user.org];
}

/** The scripted auditor: override a model DENY only for an approved base request. */
function auditorDecision(recommendation, approveIfModelDenies) {
  const valid = Boolean(recommendation) && recommendation.generationStatus === 'OK'
    && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
  if (!valid) return { decision: 'FORCE_DENY', reason: UNUSABLE_REASON };
  if (recommendation.recommendation === 'ALLOW') return { decision: 'FORCE_ALLOW' };
  return approveIfModelDenies ? { decision: 'FORCE_ALLOW', reason: OVERRIDE_REASON } : { decision: 'FORCE_DENY' };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** One request of one round. Never throws: a failure is returned as a row with the stage it failed in. */
async function runRequest({ client, watcher, stream, base, user, roundIndex, timeoutMs }) {
  const auditor = auditorFor(stream, user);
  const row = {
    id: `R${roundIndex}-${stream.streamId}`, round: roundIndex, streamId: stream.streamId, base: stream.base,
    kind: stream.kind, slot: stream.slot, username: stream.username, profile: stream.profile,
    recordId: stream.recordId, caseId: stream.caseId, action: stream.action, purpose: stream.purpose,
    plannedExpected: stream.expected, plannedReasonCode: stream.expectedReasonCode,
    approveIfModelDenies: base.approveIfModelDenies, auditor, status: 'failed', stage: 'submit',
  };
  const t0 = now();
  row.startedAt = round(t0);
  try {
    const submitted = await client.submit(stream.username, {
      recordId: stream.recordId, action: stream.action, purpose: stream.purpose, justification: stream.justification,
    });
    const t1 = now();
    const data = submitted.data || {};
    row.submitStatus = submitted.status;
    row.submitMs = round(t1 - t0);
    row.submittedAt = round(t1);
    if (![201, 202].includes(submitted.status) || !data.requestId) {
      row.error = `submit ${submitted.status}: ${submitted.error || JSON.stringify(data)}`;
      return row;
    }
    const check = data.dynamicAuthorizationCheck || {};
    Object.assign(row, {
      requestId: data.requestId,
      processingPath: data.processingPath,
      verifiedRequestHash: data.verifiedRequestHash,
      plannedFactsMatch: data.verifiedRequestHash === stream.verifiedRequestHash,
      scopeHash: data.authorizationScopeHash,
      authorizationCheck: check.outcome || null,
      checkedAuthorizationId: check.authorizationId || null,
    });

    if (submitted.status === 201) {
      row.path = 'reused';
      row.ledgerStatus = data.status;
      row.outcomeId = data.outcomeId || null;
      row.endToEndMs = row.submitMs;
      row.finishedAt = round(t1);
      if (data.processingPath !== 'dynamic-authorization' || data.status !== 'GRANTED') {
        row.error = `automatic path returned ${data.processingPath} / ${data.status}`;
        return row;
      }
      row.status = 'completed';
      row.stage = 'done';
      return row;
    }

    row.path = 'reviewed';
    row.stage = 'recommendation';
    const { entry, observedAt } = await watcher.wait(row.requestId, timeoutMs);
    row.recommendationReadyMs = round(observedAt - t1);
    const reference = referenceFor(entry.verifiedRequest);
    row.expected = reference.recommendation;
    row.expectedReasonCode = reference.reasonCode;

    row.stage = 'review';
    const reviewed = await client.review(row.requestId, auditor);
    const t3 = now();
    row.reviewStatus = reviewed.status;
    row.reviewMs = round(reviewed.ms);
    if (reviewed.status !== 200) {
      row.error = `review ${reviewed.status}: ${reviewed.error}`;
      return row;
    }
    const recommendation = reviewed.data.recommendation || {};
    const valid = recommendation.generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
    Object.assign(row, {
      generationStatus: recommendation.generationStatus || null,
      recommendation: recommendation.recommendation || null,
      reasonCode: recommendation.reasonCode || null,
      modelLatencyMs: recommendation.provenance ? recommendation.provenance.latencyMs : null,
      adapterHash: recommendation.provenance ? recommendation.provenance.adapterHash : null,
      validRecommendation: valid,
      correct: valid ? recommendation.recommendation === row.expected : false,
    });

    row.stage = 'decision';
    const body = auditorDecision(recommendation, base.approveIfModelDenies);
    const decided = await client.decide(row.requestId, auditor, body);
    const t4 = now();
    row.decision = body.decision;
    row.overrideOfModelDeny = body.decision === 'FORCE_ALLOW' && row.recommendation === 'DENY';
    row.decisionStatus = decided.status;
    row.decisionMs = round(decided.ms);
    row.decisionWaitMs = round(t3 - observedAt);
    if (decided.status !== 201) {
      row.error = `decision ${decided.status}: ${decided.error}`;
      return row;
    }
    const result = decided.data || {};
    const auditorRecord = result.auditorDecision || {};
    const authorization = result.dynamicAuthorization || null;
    Object.assign(row, {
      ledgerRecommendation: auditorRecord.llmRecommendation || null,
      ledgerAgreement: auditorRecord.llmAgreement || null,
      decisionTxId: auditorRecord.txId || null,
      ledgerOutcome: result.accessOutcome ? result.accessOutcome.outcome : null,
      createdAuthorizationId: authorization ? authorization.authorizationId : null,
      createdAuthorizationScope: authorization ? authorization.scope : null,
      endToEndMs: round(t4 - t0),
      finishedAt: round(t4),
      status: 'completed',
      stage: 'done',
    });
    return row;
  } catch (error) {
    row.error = String(error.message || error);
    row.failedAt = round(now());
    return row;
  }
}

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

async function main() {
  const opts = args(process.argv.slice(2));
  const url = opts.url || 'http://dias-backend:3001/api';
  const reviewDir = opts['review-dir'] || '/data/dias-reviews';
  const outDir = opts.out;
  if (!outDir || !opts.plan) throw new Error('--plan and --out are required');
  const planFile = path.resolve(APP, opts.plan);
  const settleMs = Number(opts.settle || 60000);
  const cooldownMs = Number(opts.cooldown || 30000);
  const timeoutMs = Number(opts.timeout || 7200000);
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const users = new Map(JSON.parse(fs.readFileSync(path.join(APP, 'testbed/load/generated/users.json'), 'utf8'))
    .map((user) => [user.username, user]));
  const streams = new Map(plan.streams.map((stream) => [stream.streamId, stream]));
  const bases = new Map(plan.bases.map((base) => [base.base, base]));
  const usernames = plan.bases.map((base) => base.username);

  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(path.join(outDir, 'run.json'))) throw new Error(`${outDir} already holds a completed run`);
  const rowsFile = path.join(outDir, 'requests.jsonl');
  const record = (row) => fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
  const client = createClient(url);
  const watcher = createWatcher(reviewDir);
  const startedAt = now();

  await inChunks([...usernames, ...AUDITORS], 10, (username) => client.login(username));
  process.stdout.write(`${plan.meta.label}: signed in ${usernames.length + AUDITORS.length} identities; settling ${settleMs / 1000} s\n`);
  await sleep(settleMs);

  const windows = [];
  for (const planned of plan.rounds) {
    const roundStart = now();
    const total = usernames.length * planned.order[usernames[0]].length;
    let finished = 0;
    const perUser = await Promise.all(usernames.map(async (username) => {
      const rows = [];
      for (const streamId of planned.order[username]) {
        const stream = streams.get(streamId);
        const row = await runRequest({
          client, watcher, stream, base: bases.get(stream.base), user: users.get(username),
          roundIndex: planned.round, timeoutMs,
        });
        row.roundStartedAt = round(roundStart);
        record(row);
        rows.push(row);
        finished += 1;
        if (finished % PROGRESS_EVERY === 0) {
          process.stdout.write(`round ${planned.round}: ${finished}/${total} finished at ${((now() - roundStart) / 60000).toFixed(1)} min\n`);
        }
      }
      return rows;
    }));
    const rows = perUser.flat();
    const roundEnd = now();
    const completed = rows.filter((row) => row.status === 'completed');
    const window = {
      round: planned.round,
      requested: rows.length,
      completed: completed.length,
      failed: rows.length - completed.length,
      reviewed: completed.filter((row) => row.path === 'reviewed').length,
      reused: completed.filter((row) => row.path === 'reused').length,
      authorizationsCreated: completed.filter((row) => row.createdAuthorizationId).length,
      factsMismatched: rows.filter((row) => row.plannedFactsMatch === false).length,
      startedAt: round(roundStart),
      finishedAt: round(roundEnd),
      durationMs: round(roundEnd - roundStart),
    };
    windows.push(window);
    fs.writeFileSync(path.join(outDir, 'rounds.json'), `${JSON.stringify(windows, null, 2)}\n`);
    process.stdout.write(`round ${planned.round} done: ${window.completed}/${window.requested} completed, `
      + `${window.reviewed} reviewed, ${window.reused} reused, ${window.authorizationsCreated} authorizations created, `
      + `${window.failed} failed, in ${(window.durationMs / 60000).toFixed(1)} min\n`);
    await sleep(cooldownMs);
  }

  const finishedAt = now();
  const totals = windows.reduce((sum, w) => ({
    requested: sum.requested + w.requested, completed: sum.completed + w.completed, failed: sum.failed + w.failed,
    reviewed: sum.reviewed + w.reviewed, reused: sum.reused + w.reused,
    authorizationsCreated: sum.authorizationsCreated + w.authorizationsCreated,
  }), { requested: 0, completed: 0, failed: 0, reviewed: 0, reused: 0, authorizationsCreated: 0 });
  fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify({
    experiment: `Reuse experiment (${plan.meta.label})`,
    planFile: path.relative(APP, planFile),
    planSha256: sha256File(planFile),
    codeSha256: Object.fromEntries(['run.js', 'plan.js', 'seed.js', 'check-ledger.js']
      .map((name) => [name, fs.existsSync(path.join(__dirname, name)) ? sha256File(path.join(__dirname, name)) : null])),
    startedAt: round(startedAt),
    finishedAt: round(finishedAt),
    startedAtUtc: new Date(startedAt).toISOString(),
    finishedAtUtc: new Date(finishedAt).toISOString(),
    apiUrl: url,
    loadGeneratorHost: os.hostname(),
    users: usernames.length,
    rounds: windows,
    totals,
    settleMs,
    cooldownMs,
    timeoutMs,
    auditorPolicy: `automated, no human review time: ${plan.meta.auditorRule}`,
  }, null, 2)}\n`);
  process.stdout.write(`done: ${totals.completed}/${totals.requested} completed (${totals.reviewed} reviewed, `
    + `${totals.reused} reused, ${totals.authorizationsCreated} authorizations) in ${((finishedAt - startedAt) / 60000).toFixed(1)} min\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`reuse run failed: ${error.stack || error}`);
    process.exit(1);
  });
}

module.exports = { auditorDecision, auditorFor };
