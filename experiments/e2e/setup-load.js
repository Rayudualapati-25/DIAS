#!/usr/bin/env node
'use strict';

/**
 * The load experiment of the three-setup plan, on the running Mac host: bursts of 5, 10 and 25 requests
 * sent at the same moment.
 */

const fs = require('fs');
const path = require('path');
const { digestOf } = require('./setup-plan');
const { PHONE_HEADERS, submission } = require('./desks');
const { describe, now, round, sleep, waitForRecommendation } = require('./lib');
const {
  API, LOG_CAP, createClient, environment, eventsCheck, hostLeftIdle, openDesks, openRun, options, quietOn,
  requireIdleHost, selected, storeWatcher,
} = require('./setup-common');

const USAGE = 'usage: setup-load.js --plan plan.json --out DIR --staging DIR [--limit N]';
const STATUS_POLL_MS = 100;
/**
 * A burst that has not finished in this time is abandoned and reported. A burst of 100 needs about 15 to 18
 * minutes, because the LLM answers one request at a time.
 */
const BURST_TIMEOUT_MS = 45 * 60000;

/** Which auditor seat takes the next decision of a burst. */
const auditorSeat = (setup, turn) => (setup === 'mac-only' ? 'mac'
  : setup === 'phone-only' ? 'phone' : (turn % 2 === 0 ? 'mac' : 'phone'));

/** The agreement the contract must have derived for a decision against an advice value. */
function expectedAgreement(decision, llmRecommendation) {
  if (!['ALLOW', 'DENY'].includes(llmRecommendation)) return 'NO_RECOMMENDATION';
  return (decision === 'FORCE_ALLOW') === (llmRecommendation === 'ALLOW') ? 'AGREED' : 'NOT_AGREED';
}

/** One decided request against its entry in the reviewer's request log. */
function checkLogEntry(row, entry, auditor) {
  const check = (name, ok) => ({ name, ok: Boolean(ok) });
  if (!entry) return [check('the request is in the request log', false)];
  return [
    check('the log names the officer and the case file of the request',
      entry.requester.username === row.username && entry.recordId === row.recordId
      && entry.action === row.action && entry.purpose === row.purpose),
    check('the ledger holds the decision that was sent, under the auditor who made it',
      entry.decision === row.decision && Boolean(entry.auditor) && entry.auditor.username === auditor),
    check('the outcome follows from the decision',
      entry.outcome === (row.decision === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED') && entry.outcome === row.outcome),
    check('the agreement follows from the committed recommendation',
      entry.llmAgreement === expectedAgreement(entry.decision, entry.llmRecommendation)),
    check('decision and outcome share one transaction', Boolean(entry.decisionTxId) && entry.decisionTxId === entry.outcomeTxId),
    check('the decision followed the committed advice',
      !row.followed || entry.llmAgreement === 'AGREED'),
  ];
}

/**
 * Send every request of the burst at the same moment; each row keeps its own result. Burst times are the
 * host's wall clock, so they can be set against the backend's own file writes.
 */
async function sendAll({ burst, rows, clients, startedWall }) {
  await Promise.all(burst.requests.map(async (item, index) => {
    const row = rows[index];
    try {
      const sent = await clients[item.officer].post('/access/request', item.username, {
        recordId: item.recordId, action: item.action, purpose: item.purpose, justification: item.justification,
      });
      row.submittedAfterMs = Date.now() - startedWall;
      row.submitHttpStatus = sent.status;
      Object.assign(row, submission({ httpStatus: sent.status, data: sent.data, error: sent.error, ms: sent.ms }));
      if (row.automatic) throw new Error('a reusable authorization granted this request; a review was expected');
      row.stage = 'recommendation';
    } catch (error) {
      row.error = String(error.message || error);
    }
  }));
}

/** The status route answers at most this many ids per call. */
const STATUS_IDS_PER_CALL = 50;

/** The preparation status of up to 50 requests; a failed read is tried twice more before it counts. */
async function preparationStatus(client, auditor, ids) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const status = await client.get(`/access/auditor/pending/status?ids=${ids.join(',')}`, auditor);
      if (status.status === 200) return status.data;
      if (attempt >= 3) throw new Error(`preparation status: ${status.status} ${status.error}`);
    } catch (error) {
      if (attempt >= 3) throw error;
    }
    await sleep(500);
  }
}

/** The preparation status of any number of requests, asked in groups the route accepts. */
async function statusInChunks(client, auditor, ids) {
  const answers = [];
  for (let index = 0; index < ids.length; index += STATUS_IDS_PER_CALL) {
    answers.push(...await preparationStatus(client, auditor, ids.slice(index, index + STATUS_IDS_PER_CALL)));
  }
  return answers;
}

/**
 * Watch the backend prepare the advice of every accepted request, and have the single auditor decide each
 * one as soon as its advice is committed.
 */
async function adviseAndDecide({ burst, rows, client, watcher, auditor, desks, startedWall }) {
  const open = new Map(rows.filter((row) => row.requestId && !row.error).map((row) => [row.requestId, row]));
  const ready = [];
  const total = open.size;
  const deadline = startedWall + BURST_TIMEOUT_MS;
  let watching = true;

  const watch = (async () => {
    try {
      while (open.size > 0 && Date.now() < deadline) {
        for (const entry of await statusInChunks(client, auditor, [...open.keys()])) {
          const row = open.get(entry.requestId);
          if (!row || entry.preparing) continue;
          open.delete(entry.requestId);
          const committed = watcher.writtenAt(row.requestId);
          const stored = watcher.createdAt(row.requestId);
          row.adviceReadyAfterMs = round(committed - startedWall);
          // From the review being stored to its advice being committed: the wait in the LLM's queue is part
          // of it.
          row.recommendationMs = stored === null ? null : round(committed - stored);
          ready.push(row);
        }
        await sleep(STATUS_POLL_MS);
      }
    } catch (error) {
      for (const row of open.values()) row.error = `the preparation status could not be read: ${error.message}`;
      open.clear();
    }
  })().finally(() => { watching = false; });

  const decide = (async () => {
    for (let taken = 0; taken < total;) {
      const row = ready.shift();
      if (!row) {
        if (!watching && ready.length === 0) break;
        await sleep(20);
        continue;
      }
      row.auditorSeat = auditorSeat(burst.setup, taken);
      taken += 1;
      const desk = desks.auditors[row.auditorSeat];
      try {
        row.stage = 'review';
        row.reviewStartedAfterMs = Date.now() - startedWall;
        Object.assign(row, await desk.open(row.requestId));
        row.stage = 'decision';
        Object.assign(row, await desk.decide(row.requestId, { readLog: false }));
        // The backend rewrites the review file once the decision is committed.
        row.decidedAfterMs = round(watcher.writtenAt(row.requestId) - startedWall);
        row.status = 'decided';
        row.stage = 'done';
      } catch (error) {
        row.error = String(error.message || error);
      }
    }
  })();

  await Promise.all([watch, decide]);
  for (const row of open.values()) row.error = row.error || 'no advice was committed before the burst was abandoned';
}

/**
 * After a burst: close every request of it that still waits, by following its advice on the Mac, so that
 * the next burst starts on an idle host.
 */
async function closeLeftovers({ rows, client, watcher, auditor, mac }) {
  const closed = [];
  const pending = await client.get('/access/auditor/pending', auditor);
  if (pending.status !== 200) throw new Error(`the auditor queue could not be read: ${pending.status}`);
  const scope = (entry) => [entry.username, entry.recordId, entry.action, entry.purpose].join('|');
  const unanswered = new Set(rows.filter((row) => !row.requestId).map(scope));
  for (const { request } of pending.data) {
    const own = rows.find((row) => row.requestId === request.requestId);
    const lost = !own && unanswered.has(scope({ ...request, username: request.requester.username }));
    if (!own && !lost) continue;
    try {
      // A burst of 100 queues its requests at the model: the last one can wait about 20 minutes.
      await waitForRecommendation(client, request.requestId, auditor, { timeoutMs: 45 * 60000 });
      await mac.open(request.requestId);
      const decided = await mac.decide(request.requestId, { readLog: false });
      closed.push({ requestId: request.requestId, decision: decided.decision, lostSubmission: lost });
      if (own) Object.assign(own, { closedAfterBurst: true, closingDecision: decided.decision });
    } catch (error) {
      closed.push({ requestId: request.requestId, error: String(error.message || error) });
    }
  }
  return closed;
}

/** One burst, from a quiet ledger to its last decision. */
async function runBurst({ burst, rows, clients, client, watcher, auditor, desks, quiet }) {
  const quietBeforeMs = round(await quiet());
  const startedAtUtc = new Date().toISOString();
  const startedWall = Date.now();
  await sendAll({ burst, rows, clients, startedWall });
  await adviseAndDecide({ burst, rows, client, watcher, auditor, desks, startedWall });
  return { quietBeforeMs, startedAtUtc };
}

/**
 * One burst in numbers. The time until all were decided covers every decided request; the per-request times
 * cover the requests that were decided and verified, and say how many those are.
 */
function burstSummary({ burst, rows, quietBeforeMs, startedAtUtc, drainMs, checks, closed = [] }) {
  const decided = rows.filter((row) => Number.isFinite(row.decidedAfterMs));
  const verified = rows.filter((row) => row.status === 'completed');
  const makespanMs = decided.length === 0 ? null : Math.max(...decided.map((row) => row.decidedAfterMs));
  return {
    id: burst.id, setup: burst.setup, level: burst.level, repeat: burst.repeat, startedAtUtc,
    requested: rows.length, accepted: rows.filter((row) => row.requestId).length, decided: decided.length,
    verified: rows.filter((row) => row.status === 'completed').length,
    failed: rows.filter((row) => row.status !== 'completed').length,
    makespanMs: round(makespanMs),
    decisionsPerMinute: makespanMs ? round((decided.length / makespanMs) * 60000) : null,
    submitMs: describe(verified.map((row) => row.submitMs)),
    adviceReadyAfterMs: describe(verified.map((row) => row.adviceReadyAfterMs)),
    decidedAfterMs: describe(verified.map((row) => row.decidedAfterMs)),
    quietBeforeMs, drainMs, checks, closedAfterBurst: closed,
  };
}

async function main() {
  const opts = options(process.argv.slice(2), ['plan', 'out', 'staging'], USAGE);
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  if (digestOf(plan) !== plan.sha256) throw new Error('the plan does not match its own digest');
  const bursts = selected(plan.load.bursts, opts);
  const auditor = plan.auditor;
  const run = openRun(opts.out);
  const client = createClient(API);
  const clients = { mac: client, phone: createClient(API, PHONE_HEADERS) };
  const quiet = quietOn(opts.staging, 30 * 60000);
  const watcher = storeWatcher(path.dirname(opts.staging));
  await requireIdleHost(client, auditor);

  const officers = [...new Set(bursts.flatMap((burst) => burst.requests.map((item) => item.username)))];
  const desks = await openDesks({
    client, auditor, officers, officerPhone: false,
    auditorPhone: bursts.some((burst) => burst.setup !== 'mac-only'),
  });
  for (const username of officers) await clients.phone.login(username);
  const meta = {
    schema: 'dias-setup-load-run-v1', planSha256: plan.sha256, planned: bursts.length, auditor,
    order: bursts.map((burst) => burst.id), startedAtUtc: new Date().toISOString(), environment: environment(),
    staging: opts.staging, phoneSignInMs: desks.phoneSignInMs, enrolledOfficers: officers.length,
  };
  run.meta(meta);

  const summaries = [];
  const checks = [];
  watcher.start();
  try {
    for (const burst of bursts) {
      const rows = burst.requests.map((item) => ({
        id: item.id, burstId: burst.id, setup: burst.setup, level: burst.level, repeat: burst.repeat,
        officerSeat: item.officer, username: item.username, recordId: item.recordId, action: item.action,
        purpose: item.purpose, auditor, status: 'failed', stage: 'submit',
      }));
      let result = { quietBeforeMs: null, startedAtUtc: new Date().toISOString() };
      let closed = [];
      try {
        result = await runBurst({ burst, rows, clients, client, watcher, auditor, desks, quiet });
      } catch (error) {
        rows.filter((row) => !row.error && row.status !== 'decided').forEach((row) => { row.error = String(error.message || error); });
      }
      try {
        closed = await closeLeftovers({ rows, client, watcher, auditor, mac: desks.auditors.mac });
      } catch (error) {
        closed = [{ error: String(error.message || error) }];
      }
      const drainStartedAt = now();
      await quiet();
      const drainMs = round(now() - drainStartedAt);
      // One read of the reviewer's log checks every request of the burst on the ledger.
      const log = await client.get(`/access/workflow-log?limit=${LOG_CAP}`, auditor);
      const entries = new Map((log.status === 200 ? log.data.entries : []).map((entry) => [entry.requestId, entry]));
      for (const row of rows.filter((entry) => entry.status === 'decided')) {
        const entry = entries.get(row.requestId);
        row.checks = checkLogEntry(row, entry, auditor);
        row.advice = entry && ['ALLOW', 'DENY'].includes(entry.llmRecommendation) ? entry.llmRecommendation : null;
        row.status = row.checks.every((check) => check.ok) ? 'completed' : 'check-failed';
      }
      const burstChecks = await eventsCheck({
        client, auditor, rows, sinceUtc: result.startedAtUtc, label: burst.id,
      });
      rows.forEach((row) => run.append(row));
      const summary = burstSummary({ burst, rows, ...result, drainMs, checks: burstChecks, closed });
      summaries.push(summary);
      fs.writeFileSync(path.join(opts.out, 'bursts.json'), `${JSON.stringify(summaries, null, 1)}\n`);
      console.log(`${burst.id} decided ${summary.decided}/${summary.requested} verified ${summary.verified} `
        + `all decided after ${summary.makespanMs == null ? '-' : `${(summary.makespanMs / 1000).toFixed(1)}s`} `
        + `(${summary.decisionsPerMinute ?? '-'} per minute), ledger quiet again after ${(drainMs / 1000).toFixed(0)}s`
        + `${closed.length ? `; ${closed.length} left over and closed` : ''}`);
      await quiet();
      // The next burst starts only on an idle host, so no burst runs behind another's backlog.
      await requireIdleHost(client, auditor);
    }
  } finally {
    watcher.stop();
    checks.push(...await desks.close());
  }

  checks.push(...await hostLeftIdle({ client, auditor }));
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const requested = summaries.reduce((sum, summary) => sum + summary.requested, 0);
  const verified = summaries.reduce((sum, summary) => sum + summary.verified, 0);
  run.meta({
    ...meta, finishedAtUtc: new Date().toISOString(), ran: summaries.length, requested, verified,
    failed: requested - verified, endChecks: checks,
  });
  console.log(`${verified} of ${requested} requests decided and verified in ${summaries.length} bursts (${bursts.length} planned)`);
  process.exitCode = summaries.length === bursts.length && verified === requested
    && checks.every((check) => check.ok) ? 0 : 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { auditorSeat, burstSummary, checkLogEntry, closeLeftovers, expectedAgreement, statusInChunks };
