#!/usr/bin/env node
'use strict';

/** One hour of 100 officers on the running Mac host (plan: plan100.js). */

const fs = require('fs');
const path = require('path');
const { hourDigestOf } = require('./plan100');
const { PHONE_HEADERS, macOfficer, submission } = require('./desks');
const { round, sleep } = require('./lib');
const { checkLogEntry, closeLeftovers } = require('./setup-load');
const {
  API, LOG_CAP, createClient, environment, hostLeftIdle, ledgerFacts, openDesks, openRun, quietOn, requireIdleHost,
  storeWatcher,
} = require('./setup-common');

const STATUS_POLL_MS = 200;
const STATUS_IDS_PER_CALL = 50;
/** After the last arrival, how long the run waits for the last decisions before it stops. */
const TAIL_MS = 30 * 60000;

function options(argv) {
  const read = (name) => (argv.indexOf(`--${name}`) === -1 ? undefined : argv[argv.indexOf(`--${name}`) + 1]);
  const parsed = { plan: read('plan'), out: read('out'), staging: read('staging'), speed: Number(read('speed') || 1),
    limit: Number(read('limit') || 0) };
  if (!parsed.plan || !parsed.out || !parsed.staging || !(parsed.speed >= 1)) {
    throw new Error('usage: setup-hour.js --plan plan-100.json --out DIR --staging DIR [--speed X] [--limit N]');
  }
  return parsed;
}

/**
 * What the phone app reads to show a request (ApiClient.progress): the request, then the decision once
 * there is one.
 */
async function phoneOutcome(client, item, requestId) {
  const request = await client.get(`/access/request/${requestId}`, item.username);
  const calls = [request];
  const status = request.data && request.data.status;
  if (request.status === 200 && ['granted', 'denied'].includes(status) && request.data.processingPath !== 'dynamic-authorization') {
    calls.push(await client.get(`/access/request/${requestId}/recommendation`, item.username));
  }
  const failed = calls.find((call) => call.status !== 200);
  if (failed) throw new Error(`outcome read ${failed.status}: ${failed.error}`);
  return { outcomeMs: round(calls.reduce((sum, call) => sum + call.ms, 0)), outcomeCalls: calls.length,
    officerSees: String(status).toUpperCase() };
}

/** Wait until a time measured from the start, on the wall clock. */
const until = (startedWall, atMs) => sleep(Math.max(0, startedWall + atMs - Date.now()));

async function main() {
  const opts = options(process.argv.slice(2));
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  if (hourDigestOf(plan) !== plan.hourSha256) throw new Error('the hour of the plan does not match its own digest');
  const scale = (ms) => Math.round(ms / opts.speed);
  const arrivals = plan.hour.arrivals.slice(0, opts.limit || undefined);
  const lastArrival = arrivals.length ? arrivals[arrivals.length - 1].atMs : 0;
  const logReads = plan.hour.logReads.filter((read) => read.atMs <= lastArrival + 60000);
  const auditor = plan.auditor;
  const run = openRun(opts.out);
  const readsFile = path.join(opts.out, 'reads.jsonl');
  const client = createClient(API);
  const clients = { mac: client, phone: createClient(API, PHONE_HEADERS) };
  const watcher = storeWatcher(path.dirname(opts.staging));
  await requireIdleHost(client, auditor);

  // Everyone signs in before the hour starts, on the client their seat uses.
  const people = new Map([...arrivals, ...logReads].map((entry) => [entry.username, entry.officer]));
  for (const [username, seat] of people) await clients[seat].login(username);
  const desks = await openDesks({ client, auditor, officers: [], officerPhone: false, auditorPhone: true });
  const portal = macOfficer(client);
  const meta = {
    schema: 'dias-100-user-hour-run-v1', planSha256: plan.sha256, hourSha256: plan.hourSha256, auditor,
    planned: arrivals.length, logReads: logReads.length, officers: people.size, speed: opts.speed,
    environment: environment(), staging: opts.staging, phoneSignInMs: desks.phoneSignInMs,
  };
  run.meta(meta);

  const quiet = quietOn(opts.staging, 30 * 60000);
  meta.quietBeforeMs = round(await quiet());
  meta.startedAtUtc = new Date().toISOString();
  const startedWall = Date.now();
  watcher.start();

  const rows = arrivals.map((item) => ({ ...item, auditor, status: 'failed', stage: 'waiting' }));
  const open = new Map();
  const ready = [];
  const pendingReads = [];
  let submitting = arrivals.length;
  let watchError = null;

  // 1. Requests at their planned moments.
  const submitted = rows.map(async (row) => {
    await until(startedWall, scale(row.atMs));
    row.stage = 'submit';
    row.sentAfterMs = Date.now() - startedWall;
    try {
      const sent = await clients[row.officer].post('/access/request', row.username, {
        recordId: row.recordId, action: row.action, purpose: row.purpose, justification: row.justification,
      });
      Object.assign(row, submission({ httpStatus: sent.status, data: sent.data, error: sent.error, ms: sent.ms }));
      if (row.automatic) throw new Error('a reusable authorization granted this request; a review was expected');
      row.stage = 'recommendation';
      open.set(row.requestId, row);
    } catch (error) {
      row.error = String(error.message || error);
    } finally {
      submitting -= 1;
    }
  });

  // 2. The access log, read by one officer every 30 s.
  const logs = logReads.map(async (read) => {
    await until(startedWall, scale(read.atMs));
    const entry = { kind: 'access-log', username: read.username, seat: read.officer, atMs: Date.now() - startedWall };
    try {
      const log = await clients[read.officer].get('/access/workflow-log?limit=100', read.username);
      Object.assign(entry, { httpStatus: log.status, ms: round(log.ms), entries: log.data ? log.data.entries.length : null });
    } catch (error) {
      entry.error = String(error.message || error);
    }
    fs.appendFileSync(readsFile, `${JSON.stringify(entry)}\n`);
  });

  // 3. The backend's advice, as it is committed.
  const deadline = () => startedWall + scale(lastArrival) + TAIL_MS;
  const watch = (async () => {
    while ((submitting > 0 || open.size > 0) && Date.now() < deadline()) {
      const ids = [...open.keys()];
      for (let index = 0; index < ids.length; index += STATUS_IDS_PER_CALL) {
        const chunk = ids.slice(index, index + STATUS_IDS_PER_CALL);
        let status = null;
        for (let attempt = 1; attempt <= 3 && !status; attempt += 1) {
          try {
            const answer = await client.get(`/access/auditor/pending/status?ids=${chunk.join(',')}`, auditor);
            if (answer.status === 200) status = answer.data;
          } catch (_) { /* Tried again below */ }
          if (!status) await sleep(500);
        }
        if (!status) { watchError = 'the preparation status could not be read three times in a row'; return; }
        for (const entry of status) {
          const row = open.get(entry.requestId);
          if (!row || entry.preparing) continue;
          open.delete(entry.requestId);
          const committed = watcher.writtenAt(row.requestId);
          const stored = watcher.createdAt(row.requestId);
          row.adviceReadyAfterMs = round(committed - startedWall);
          row.recommendationMs = stored === null ? null : round(committed - stored);
          ready.push(row);
        }
      }
      await sleep(STATUS_POLL_MS);
    }
  })();

  // 4. One auditor, deciding in the order the advice is committed, alternating seats.
  const decide = (async () => {
    let turn = 0;
    while (submitting > 0 || open.size > 0 || ready.length > 0) {
      if (Date.now() > deadline() || watchError) break;
      const row = ready.shift();
      if (!row) { await sleep(20); continue; }
      row.auditorSeat = turn % 2 === 0 ? 'mac' : 'phone';
      turn += 1;
      try {
        row.stage = 'review';
        row.reviewStartedAfterMs = Date.now() - startedWall;
        Object.assign(row, await desks.auditors[row.auditorSeat].open(row.requestId));
        row.stage = 'decision';
        Object.assign(row, await desks.auditors[row.auditorSeat].decide(row.requestId, { readLog: false }));
        row.decidedAfterMs = round(watcher.writtenAt(row.requestId) - startedWall);
        row.status = 'decided';
        row.stage = 'outcome';
        // 5. The officer reads the outcome some seconds later.
        pendingReads.push((async () => {
          await until(startedWall, row.decidedAfterMs + scale(row.outcomeReadAfterMs));
          try {
            Object.assign(row, row.officer === 'mac'
              ? await portal.outcome(row, row.requestId) : await phoneOutcome(clients.phone, row, row.requestId));
            row.outcomeReadAfterDecisionMs = Date.now() - startedWall - row.decidedAfterMs;
            row.stage = 'done';
          } catch (error) {
            row.outcomeError = String(error.message || error);
          }
        })());
      } catch (error) {
        row.error = String(error.message || error);
      }
    }
  })();

  await Promise.all([...submitted, watch, decide]);
  await Promise.all([...logs, ...pendingReads]);
  watcher.stop();
  meta.finishedHourAtUtc = new Date().toISOString();
  meta.watchError = watchError;
  const checks = await desks.close();

  // After the hour: close what still waits, let the ledger catch up, then check every request on it.
  meta.closedAfterHour = await closeLeftovers({ rows, client, watcher, auditor, mac: desks.auditors.mac });
  const drainStarted = Date.now();
  await quiet();
  meta.drainMs = Date.now() - drainStarted;
  const log = await client.get(`/access/workflow-log?limit=${LOG_CAP}`, auditor);
  const entries = new Map((log.status === 200 ? log.data.entries : []).map((entry) => [entry.requestId, entry]));
  for (const row of rows.filter((entry) => entry.status === 'decided')) {
    row.checks = checkLogEntry(row, entries.get(row.requestId), auditor);
    const trail = await client.get(`/audit/request-trail/${row.requestId}`, auditor);
    if (trail.status === 200) Object.assign(row, ledgerFacts(trail.data));
    row.officerOk = row.officerSees === row.outcome;
    row.status = row.checks.every((check) => check.ok) && row.officerOk ? 'completed' : 'check-failed';
  }
  run.rewrite(rows);
  await quiet();
  checks.push(...await hostLeftIdle({ client, auditor }));
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const completed = rows.filter((row) => row.status === 'completed').length;
  run.meta({ ...meta, finishedAtUtc: new Date().toISOString(), completed, failed: rows.length - completed, endChecks: checks });
  console.log(`${completed} of ${rows.length} requests decided, read by their officer and verified`);
  process.exitCode = completed === rows.length && checks.every((check) => check.ok) ? 0 : 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { phoneOutcome };
