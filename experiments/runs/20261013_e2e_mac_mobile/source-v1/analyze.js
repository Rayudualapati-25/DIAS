#!/usr/bin/env node
'use strict';

/**
 * Tables for the end-to-end experiment, from the rows the runner wrote.
 *
 * Latency lines use completed workflows only: a workflow that failed, or failed
 * one of its checks, is counted in the summary and left out of the times. A
 * stage nobody measured is left out, never shown as zero.
 *
 * usage: analyze.js --mac DIR --mobile DIR --out DIR --tables DIR --date YYYYMMDD
 */

const fs = require('fs');
const path = require('path');
const { summarize } = require('./lib');

const sum = (...values) => (values.every((value) => Number.isFinite(value)) ? values.reduce((a, b) => a + b, 0) : null);

/** The stages in the order a workflow goes through them. */
const STAGES = Object.freeze([
  { key: 'submit', label: '1. Request committed on the ledger', value: (row) => row.submitMs },
  { key: 'recommendation', label: '2. Recommendation ready (LLM, signature, commitment)', value: (row) => row.recommendationMs },
  { key: 'inference', label: '   of which: model inference', value: (row) => row.modelInferenceMs },
  { key: 'queue', label: '3. Auditor reads the queue', value: (row) => row.queueMs },
  { key: 'review', label: '4. Auditor opens the review', value: (row) => row.reviewMs },
  { key: 'decision', label: '5. Decision recorded and confirmed from the ledger', value: (row) => sum(row.decisionMs, row.readbackMs) },
  { key: 'endToEnd', label: 'End to end (stages 1 to 5)', value: (row) => row.endToEndMs },
  { key: 'log', label: '6. Access log read', value: (row) => row.logMs },
  { key: 'requesterReadback', label: 'Requester reads the outcome on the Mac', value: (row) => row.requesterReadbackMs },
  { key: 'phoneSignIn', label: 'Phone sign-in (not part of the end-to-end time)', value: (row) => row.phoneSignInMs },
]);
const AUDITOR_STAGES = Object.freeze(['queue', 'review', 'decision', 'log']);

function stageTable(rows) {
  const completed = rows.filter((row) => row.status === 'completed');
  return STAGES
    .map((stage) => ({ stage, stats: summarize(completed.map(stage.value)) }))
    .filter(({ stats }) => stats !== null)
    .map(({ stage, stats }) => ({ key: stage.key, label: stage.label, ...stats }));
}

function runSummary(rows, { planned }) {
  const count = (test) => rows.filter(test).length;
  const checks = rows.flatMap((row) => row.checks || []);
  const failedStages = {};
  rows.filter((row) => row.status === 'failed').forEach((row) => { failedStages[row.stage] = (failedStages[row.stage] || 0) + 1; });
  return {
    planned, ran: rows.length,
    completed: count((row) => row.status === 'completed'),
    checkFailed: count((row) => row.status === 'check-failed'),
    failed: count((row) => row.status === 'failed'),
    notRun: planned - rows.length,
    granted: count((row) => row.outcome === 'GRANTED'), denied: count((row) => row.outcome === 'DENIED'),
    adviceAllow: count((row) => row.advice === 'ALLOW'), adviceDeny: count((row) => row.advice === 'DENY'),
    adviceFollowed: count((row) => row.followed === true),
    adviceMatchesPolicy: count((row) => row.recommendation && row.policyAnswer && row.adviceMatchesPolicy === true),
    adviceCompared: count((row) => row.recommendation && row.policyAnswer),
    ledgerChecksPassed: checks.filter((check) => check.ok).length, ledgerChecksMade: checks.length,
    failedStages,
  };
}

/** Phone minus Mac, on the medians of the stages the auditor performs. */
function phoneDifference(macTable, phoneTable) {
  const median = (table, key) => (table.find((line) => line.key === key) || {}).median;
  return AUDITOR_STAGES
    .filter((key) => Number.isFinite(median(macTable, key)) && Number.isFinite(median(phoneTable, key)))
    .map((key) => ({
      key, macMedian: median(macTable, key), phoneMedian: median(phoneTable, key),
      differenceMs: Math.round((median(phoneTable, key) - median(macTable, key)) * 10) / 10,
    }));
}

module.exports = { AUDITOR_STAGES, STAGES, phoneDifference, runSummary, stageTable };

// --- command line -----------------------------------------------------------

const seconds = (ms) => (ms / 1000).toFixed(2);
const readRows = (dir) => fs.readFileSync(path.join(dir, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const NAMES = Object.freeze({ mac: 'A. Mac alone', mobile: 'B. Mac and phone' });

function markdown({ runs, difference }) {
  const lines = ['# End-to-end experiment: results', '',
    'Times are in seconds, measured on completed workflows only. The median and the 95th percentile use the nearest rank.', ''];
  lines.push('## Workflows', '', '| Configuration | Planned | Completed and verified | Failed a check | Failed | Granted | Denied | Advice matched the written policy | Ledger checks passed |',
    '|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const s = run.summary;
    lines.push(`| ${NAMES[run.config]} | ${s.planned} | ${s.completed} | ${s.checkFailed} | ${s.failed} | ${s.granted} | ${s.denied} | ${s.adviceMatchesPolicy} of ${s.adviceCompared} | ${s.ledgerChecksPassed} of ${s.ledgerChecksMade} |`);
  }
  for (const run of runs) {
    lines.push('', `## Stage times: ${NAMES[run.config]}`, '', '| Stage | n | Min | Median | Mean | p95 | Max |', '|---|---|---|---|---|---|---|');
    run.table.forEach((line) => lines.push(`| ${line.label.trim()} | ${line.n} | ${seconds(line.min)} | ${seconds(line.median)} | ${seconds(line.mean)} | ${seconds(line.p95)} | ${seconds(line.max)} |`));
    lines.push('', '### Checks after the run', '');
    run.meta.endChecks.forEach((check) => lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.name} (${check.detail})`));
  }
  if (difference.length) {
    const label = (key) => STAGES.find((stage) => stage.key === key).label.trim();
    lines.push('', '## The auditor\'s steps: phone against Mac (medians)', '', '| Stage | Mac | Phone | Phone minus Mac |', '|---|---|---|---|');
    difference.forEach((line) => lines.push(`| ${label(line.key)} | ${seconds(line.macMedian)} | ${seconds(line.phoneMedian)} | ${line.differenceMs >= 0 ? '+' : ''}${seconds(line.differenceMs)} |`));
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const read = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
  const dirs = { mac: read('mac'), mobile: read('mobile') };
  const out = read('out');
  const tables = read('tables');
  const date = read('date');
  const runs = Object.entries(dirs).filter(([, dir]) => dir && fs.existsSync(path.join(dir, 'rows.jsonl'))).map(([config, dir]) => {
    const rows = readRows(dir);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    return { config, rows, meta, table: stageTable(rows), summary: runSummary(rows, { planned: meta.planned }) };
  });
  const tableOf = (config) => (runs.find((run) => run.config === config) || { table: [] }).table;
  const difference = phoneDifference(tableOf('mac'), tableOf('mobile'));

  const stageCsv = ['configuration,stage,n,min_ms,median_ms,mean_ms,p95_ms,max_ms'];
  runs.forEach((run) => run.table.forEach((line) => stageCsv.push(
    [run.config, `"${line.label.trim()}"`, line.n, line.min, line.median, line.mean, line.p95, line.max].join(','))));
  const summaryKeys = ['planned', 'ran', 'completed', 'checkFailed', 'failed', 'notRun', 'granted', 'denied', 'adviceAllow',
    'adviceDeny', 'adviceFollowed', 'adviceMatchesPolicy', 'adviceCompared', 'ledgerChecksPassed', 'ledgerChecksMade'];
  const summaryCsv = [['configuration', ...summaryKeys, 'endChecksPassed', 'endChecksMade'].join(',')];
  runs.forEach((run) => summaryCsv.push([run.config, ...summaryKeys.map((key) => run.summary[key]),
    run.meta.endChecks.filter((check) => check.ok).length, run.meta.endChecks.length].join(',')));
  const differenceCsv = ['stage,mac_median_ms,phone_median_ms,phone_minus_mac_ms',
    ...difference.map((line) => [line.key, line.macMedian, line.phoneMedian, line.differenceMs].join(','))];

  fs.writeFileSync(path.join(tables, `${date}_e2e_stage_latency.csv`), `${stageCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(tables, `${date}_e2e_summary.csv`), `${summaryCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(tables, `${date}_e2e_phone_vs_mac.csv`), `${differenceCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'analysis.json'), `${JSON.stringify({ runs: runs.map(({ config, table, summary }) => ({ config, table, summary })), difference }, null, 1)}\n`);
  fs.writeFileSync(path.join(out, 'RESULTS.md'), markdown({ runs, difference }));
  process.stdout.write(markdown({ runs, difference }));
}

if (require.main === module) main();
