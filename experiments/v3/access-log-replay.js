#!/usr/bin/env node
'use strict';

/**
 * Access-log policy replay (plan step 6).
 *
 * Replays the HTTP calls recorded in real testbed backend traces through the
 * backend's own classifier (backend/src/middleware/accessLogger.js) and counts
 * the access-log ledger writes each logging mode would submit:
 *
 *   all       every attributable call, as the evaluated v2 system did;
 *   security  the v3 default (sensitive reads always; other calls only when
 *             refused or failed).
 *
 * The all-mode replay uses the evaluated v2 classifier itself (read from the
 * baseline tag) and is checked call by call against the access-log writes the
 * trace records (fabric.submit RecordAccessEvent, whose first argument is the
 * action, submitted just after the response). A call with no matching write
 * within one second is reported with its time, so lost writes can be explained.
 * The measured latency of the recorded writes is their cost.
 *
 *   node experiments/v3/access-log-replay.js --out DIR --trace PATH[@since=OTHER] ...
 *
 * `@since=OTHER` keeps only events after the last event of trace OTHER, for a
 * trace file that kept growing across runs. Offline: it reads saved traces only.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { describe, shouldLog } = require('../../backend/src/middleware/accessLogger');

const REPO = path.resolve(__dirname, '..', '..');
const BASELINE_TAG = 'eval-baseline-2026-10-01';

/** The v2 access logger exactly as evaluated, loaded from the baseline tag. */
function baselineClassifier() {
  const source = execFileSync('git', ['show', `${BASELINE_TAG}:backend/src/middleware/accessLogger.js`], { cwd: REPO })
    .toString()
    .replace("const fabric = require('../fabric/gateway');", 'const fabric = null;');
  const loaded = new Module('baseline-access-logger');
  loaded._compile(source, 'baseline-accessLogger.js');
  return loaded.exports.describe;
}
const describeV2 = baselineClassifier();

function argumentList(name) {
  const values = [];
  process.argv.forEach((value, index) => {
    if (value === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1]);
  });
  return values;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)] * 1000) / 1000;
}

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    mean: sorted.length ? Math.round((total / sorted.length) * 1000) / 1000 : null,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

const increment = (map, key) => { map[key] = (map[key] || 0) + 1; };

/** The action a classifier logs for one recorded HTTP call, or null when it logs nothing. */
function loggedAction(classify, event) {
  const apiPath = String(event.path).split('?')[0].replace(/^\/api/, '') || '/';
  const described = classify({ method: event.method, path: apiPath, query: {}, body: {} });
  if (!described) return null;
  // A call without an authenticated identity cannot be attributed on-chain.
  if (event.status === 401) return null;
  return described.action === 'auth.login' && event.status !== 200 ? 'auth.login_failed' : described.action;
}

const readTrace = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/**
 * Calls whose access-log write was never recorded. The logger submits a write
 * as soon as the response finishes, so per action the calls (by finish time) and
 * the writes (by submit start, not by commit order) are merged in time order; a
 * call with no write submitted within one second has no recorded write.
 */
function unrecordedCalls(calls, writes) {
  const missing = [];
  let writesWithoutCall = 0;
  const actions = new Set([...calls.map((call) => call.action), ...writes.map((write) => write.arg0)]);
  for (const action of actions) {
    const ordered = calls.filter((call) => call.action === action).sort((a, b) => a.at - b.at);
    const starts = writes.filter((write) => write.arg0 === action)
      .map((write) => write.startedAt).sort((a, b) => a - b);
    let next = 0;
    for (const call of ordered) {
      while (next < starts.length && starts[next] < call.at - 5) {
        writesWithoutCall += 1;
        next += 1;
      }
      if (next < starts.length && starts[next] - call.at < 1000) next += 1;
      else missing.push(call);
    }
    writesWithoutCall += starts.length - next;
  }
  missing.sort((a, b) => a.at - b.at);
  return { missing, writesWithoutCall };
}

function analyse(spec) {
  const [file, option] = spec.split('@since=');
  const tracePath = path.resolve(file);
  let lines = readTrace(tracePath);
  let since = null;
  if (option) {
    since = Math.max(...readTrace(path.resolve(option)).map((event) => event.at));
    lines = lines.filter((event) => event.at > since);
  }
  const http = lines.filter((event) => event.event === 'http');
  const submits = lines.filter((event) => event.event === 'fabric.submit');
  const accessLogWrites = submits.filter((event) => event.fn === 'RecordAccessEvent');

  const observedByAction = {};
  for (const event of accessLogWrites) increment(observedByAction, event.arg0);

  const replayAll = {};
  const replaySecurity = {};
  const v2Calls = [];
  let notLoggable = 0;
  for (const event of http) {
    const v2Action = loggedAction(describeV2, event);
    if (!v2Action) { notLoggable += 1; continue; }
    increment(replayAll, v2Action);
    v2Calls.push({ action: v2Action, at: event.at, method: event.method, path: event.path });
    const action = loggedAction(describe, event);
    if (action && shouldLog({ mode: 'security', action, status: event.status })) increment(replaySecurity, action);
  }
  const { missing, writesWithoutCall } = unrecordedCalls(v2Calls, accessLogWrites);

  const sum = (map) => Object.values(map).reduce((total, value) => total + value, 0);
  const actions = [...new Set([...Object.keys(observedByAction), ...Object.keys(replayAll)])].sort();
  const mismatches = actions
    .filter((action) => (observedByAction[action] || 0) !== (replayAll[action] || 0))
    .map((action) => ({ action, observed: observedByAction[action] || 0, replayed: replayAll[action] || 0 }));
  const workflows = submits.filter((event) => event.fn === 'CreateAccessRequest').length;
  const byFunction = {};
  for (const event of submits) increment(byFunction, event.fn);

  return {
    trace: path.relative(process.cwd(), tracePath),
    onlyEventsAfter: since,
    sinceTrace: option ? path.relative(process.cwd(), path.resolve(option)) : null,
    httpCalls: http.length,
    notLoggable,
    ledgerSubmits: { total: submits.length, byFunction },
    accessLogWrites: {
      observed: accessLogWrites.length,
      replayedAllMode: sum(replayAll),
      replayedSecurityMode: sum(replaySecurity),
      shareOfLedgerSubmitsObserved: submits.length
        ? Math.round((accessLogWrites.length / submits.length) * 10000) / 10000 : null,
      perWorkflowObserved: workflows ? Math.round((accessLogWrites.length / workflows) * 1000) / 1000 : null,
      perWorkflowSecurityMode: workflows ? Math.round((sum(replaySecurity) / workflows) * 1000) / 1000 : null,
      replayMatchesObservedPerAction: mismatches.length === 0,
      mismatches,
      callsWithoutRecordedWrite: missing.map((call) => ({ action: call.action, at: call.at, path: call.path })),
      recordedWritesWithoutCallInWindow: writesWithoutCall,
    },
    byAction: actions.map((action) => ({
      action,
      observed: observedByAction[action] || 0,
      allModeV2Classifier: replayAll[action] || 0,
    })),
    securityModeByAction: replaySecurity,
    measuredCostOfAccessLogWrites: {
      totalMs: stats(accessLogWrites.map((event) => event.totalMs)),
      endorseMs: stats(accessLogWrites.map((event) => event.endorseMs)),
      ordererSubmitMs: stats(accessLogWrites.map((event) => event.ordererSubmitMs)),
      commitWaitMs: stats(accessLogWrites.map((event) => event.commitWaitMs)),
      failed: accessLogWrites.filter((event) => event.successful === false).length,
    },
    workflowsCreated: workflows,
  };
}

function main() {
  const traces = argumentList('trace');
  const [outDir] = argumentList('out');
  if (traces.length === 0 || !outDir) {
    throw new Error('usage: access-log-replay.js --out DIR --trace PATH [--trace PATH]');
  }
  const results = traces.map((trace) => analyse(trace));
  const report = {
    experiment: 'v3-access-log-policy-replay',
    kind: 'offline replay of recorded testbed HTTP traffic through the backend classifier',
    modes: {
      all: `v2 behaviour: every attributable call, classified by ${BASELINE_TAG}`,
      security: 'v3 default (design §12), classified by the current backend',
    },
    results,
    node: process.version,
  };
  fs.mkdirSync(path.resolve(outDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(outDir), 'access-log-replay.json'), `${JSON.stringify(report, null, 2)}\n`);
  for (const result of results) {
    process.stdout.write(`${result.trace}: http ${result.httpCalls}, observed ${result.accessLogWrites.observed}, `
      + `all ${result.accessLogWrites.replayedAllMode}, security ${result.accessLogWrites.replayedSecurityMode}, `
      + `unrecorded ${result.accessLogWrites.callsWithoutRecordedWrite.length}\n`);
  }
}

main();
