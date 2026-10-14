#!/usr/bin/env node
'use strict';

/**
 * The step experiment of the three-setup plan, on the running Mac host: one workflow at a time, in the
 * plan's order, over four cells.
 */

const fs = require('fs');
const path = require('path');
const { digestOf } = require('./setup-plan');
const {
  API, LOG_CAP, ORDINARY_READER, createClient, environment, eventsCheck, hostLeftIdle, openDesks, openRun,
  options, quietOn, requireIdleHost, reviewedWorkflow, selected, storeWatcher, verifyReviewed,
} = require('./setup-common');

const USAGE = 'usage: setup-steps.js --plan plan.json --out DIR --staging DIR [--limit N]';
/** The searches-and-reads log returns 500 events; this many workflows stay well below that. */
const CHECK_EVERY = 24;
/** A second officer outside the reviewer set, for when the first one made the request. */
const OTHER_READER = 'analyst.rao';

/**
 * While a request waits with its advice committed: another officer reads it in the access log with the
 * advice withheld, and the auditor reads the advice.
 */
async function waitingRequestAsOthersSeeIt({ client, auditor, row }) {
  const reader = row.username === ORDINARY_READER ? OTHER_READER : ORDINARY_READER;
  const entryFor = async (username) => {
    const log = await client.get('/access/workflow-log?limit=100', username);
    return (log.status === 200 ? log.data.entries : []).find((entry) => entry.requestId === row.requestId) || {};
  };
  const officer = await entryFor(reader);
  const reviewer = await entryFor(auditor);
  return {
    waitingCheck: {
      reader,
      officerSeesWhoAskedForWhat: officer.requestId === row.requestId && Boolean(officer.requester)
        && officer.requester.username === row.username && officer.recordId === row.recordId,
      adviceWithheldFromOfficer: officer.status === 'awaiting-auditor' && officer.llmRecommendation === null
        && officer.recommendationWithheld === true,
      auditorSeesAdvice: reviewer.recommendationWithheld === false
        && (['ALLOW', 'DENY'].includes(reviewer.llmRecommendation) || reviewer.generationStatus !== 'OK'),
    },
  };
}

/** The logs every kind of user reads must hold all of the run. No check passes on an empty run. */
async function logChecks({ client, rows }) {
  const done = rows.filter((row) => row.requestId && row.outcomeId);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok) && done.length > 0, detail });

  const log = await client.get(`/access/workflow-log?limit=${LOG_CAP}`, ORDINARY_READER);
  const entries = new Map((log.status === 200 ? log.data.entries : []).map((entry) => [entry.requestId, entry]));
  const shown = done.filter((row) => {
    const entry = entries.get(row.requestId);
    return entry && entry.requester.username === row.username && entry.recordId === row.recordId
      && entry.decision === row.decision && entry.outcome === row.outcome
      && Boolean(entry.auditor) && entry.auditor.username === row.auditor;
  }).length;
  check('an officer outside the reviewers reads every workflow in the access log: who, which file, decision, outcome',
    shown === done.length, `${shown} of ${done.length} shown to ${ORDINARY_READER}`);
  const sample = [...entries.values()];
  check('that log holds no transaction identifier and no digest',
    sample.length > 0 && sample.every((entry) => !Object.keys(entry).some((name) => /TxId$/.test(name)))
    && !/Hash"/.test(JSON.stringify(sample)), `${sample.length} entries read`);

  const sampled = rows.filter((row) => row.waitingCheck);
  const passed = sampled.filter((row) => Object.entries(row.waitingCheck)
    .every(([name, value]) => name === 'reader' || value === true)).length;
  check('while a request waited, another officer saw who asked for which file but not the advice; the auditor saw the advice',
    sampled.length > 0 && passed === sampled.length, `${passed} of ${sampled.length} sampled workflows`);

  const byRequester = new Map();
  done.forEach((row) => byRequester.set(row.username, [...(byRequester.get(row.username) || []), row]));
  let ownOk = 0;
  for (const [username, own] of byRequester) {
    const mine = await client.get(`/access/requests/mine?limit=${LOG_CAP}`, username);
    const status = new Map((mine.data ? mine.data.entries : []).map((entry) => [entry.requestId, entry.status]));
    if (own.every((row) => String(status.get(row.requestId)).toUpperCase() === row.outcome)) ownOk += 1;
  }
  check('each requester finds their own requests with the final outcome', ownOk === byRequester.size,
    `${ownOk} of ${byRequester.size} requesters`);
  return checks;
}

const seconds = (ms) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);

async function main() {
  const opts = options(process.argv.slice(2), ['plan', 'out', 'staging'], USAGE);
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  if (digestOf(plan) !== plan.sha256) throw new Error('the plan does not match its own digest');
  const byId = new Map(plan.steps.items.map((item) => [item.id, item]));
  const items = selected(plan.steps.order.map((id) => byId.get(id)), opts);
  const auditor = plan.auditor;
  const run = openRun(opts.out);
  const client = createClient(API);
  const quiet = quietOn(opts.staging);
  const watcher = storeWatcher(path.dirname(opts.staging));
  await requireIdleHost(client, auditor);

  const desks = await openDesks({
    client, auditor, officers: [...new Set(items.map((item) => item.username))],
    officerPhone: items.some((item) => item.officer === 'phone'),
    auditorPhone: items.some((item) => item.auditor === 'phone'),
  });
  const meta = {
    schema: 'dias-setup-steps-run-v1', planSha256: plan.sha256, planned: items.length, auditor,
    order: items.map((item) => item.id), startedAtUtc: new Date().toISOString(), environment: environment(),
    staging: opts.staging, phoneSignInMs: desks.phoneSignInMs,
  };
  run.meta(meta);

  const rows = [];
  const checks = [];
  const sampledCells = new Set();
  let partStart = 0;
  watcher.start();
  try {
    for (const [index, item] of items.entries()) {
      const sample = !sampledCells.has(item.cell);
      sampledCells.add(item.cell);
      const row = await reviewedWorkflow({
        client, watcher, item, auditor, quiet,
        officerDesk: desks.officers[item.officer], auditorDesk: desks.auditors[item.auditor],
        whileWaiting: sample ? (waiting) => waitingRequestAsOthersSeeIt({ client, auditor, row: waiting }) : null,
      });
      Object.assign(row, { cell: item.cell, setup: item.setup, officerSeat: item.officer, auditorSeat: item.auditor });
      rows.push(row);
      run.append(row);
      console.log(`${row.id} ${row.status} ${row.requestId || '-'} outcome=${row.outcome || '-'} e2e=${seconds(row.endToEndMs)}`
        + `${row.error ? ` ERROR at ${row.stage}: ${row.error}` : ''}`);
      if (row.status === 'failed') {
        console.error(row.decisionSent
          ? 'stopping: a decision was sent and not confirmed; read the request before anything else is done'
          : 'stopping: a workflow failed before its decision was sent');
        break;
      }
      if ((index + 1) % CHECK_EVERY === 0 || index + 1 === items.length) {
        await quiet();
        checks.push(...await eventsCheck({
          client, auditor, rows: rows.slice(partStart), sinceUtc: meta.startedAtUtc,
          label: `workflows ${partStart + 1} to ${index + 1}`,
        }));
        partStart = index + 1;
      }
    }
  } finally {
    watcher.stop();
    checks.push(...await desks.close());
  }

  for (const row of rows.filter((entry) => entry.status === 'decided')) await verifyReviewed({ client, row, auditor });
  run.rewrite(rows);
  // The verification reads are logged as well; wait until they are on the ledger.
  await quietOn(opts.staging, 30 * 60000)();
  checks.push(...await logChecks({ client, rows }), ...await hostLeftIdle({ client, auditor }));
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const completed = rows.filter((row) => row.status === 'completed').length;
  run.meta({
    ...meta, finishedAtUtc: new Date().toISOString(), ran: rows.length, completed, failed: rows.length - completed,
    endChecks: checks,
  });
  console.log(`${completed} of ${rows.length} workflows completed and verified (${items.length} planned)`);
  process.exitCode = completed === items.length && checks.every((check) => check.ok) ? 0 : 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { logChecks, waitingRequestAsOthersSeeIt };
