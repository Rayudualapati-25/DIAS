#!/usr/bin/env node
'use strict';

/** Tables for the end-to-end experiment, from the rows the runner wrote. */

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
  { key: 'quietBeforeRequest', label: 'Wait for a quiet ledger before the request (not counted)', value: (row) => row.quietBeforeRequestMs },
  { key: 'quietBeforeDecision', label: 'Wait for a quiet ledger before the decision (not counted)', value: (row) => row.quietBeforeDecisionMs },
]);
/** Stages the auditor performs: the only ones that can differ between the Mac and the phone. */
const AUDITOR_STAGES = Object.freeze(['queue', 'review', 'decision', 'log']);
/** Stages that run on the Mac whoever the auditor is. */
const SHARED_STAGES = Object.freeze(['submit', 'recommendation', 'inference']);

/** Workflows whose times are used. */
const timed = (rows) => rows.filter((row) => row.status === 'completed' && row.followed === true);

function tableOf(rows, stages) {
  return stages
    .map((stage) => ({ stage, stats: summarize(rows.map(stage.value)) }))
    .filter(({ stats }) => stats !== null)
    .map(({ stage, stats }) => ({ key: stage.key, label: stage.label, ...stats }));
}

const stageTable = (rows) => tableOf(timed(rows), STAGES);
const pooledTable = (rows) => tableOf(timed(rows), STAGES.filter((stage) => SHARED_STAGES.includes(stage.key)));

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
    timed: timed(rows).length,
    noUsableAdvice: count((row) => row.status === 'completed' && row.followed === false),
    granted: count((row) => row.outcome === 'GRANTED'), denied: count((row) => row.outcome === 'DENIED'),
    adviceAllow: count((row) => row.advice === 'ALLOW'), adviceDeny: count((row) => row.advice === 'DENY'),
    adviceFollowed: count((row) => row.followed === true),
    adviceMatchesPolicy: count((row) => row.advice && row.policyAnswer && row.adviceMatchesPolicy === true),
    adviceCompared: count((row) => row.advice && row.policyAnswer),
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

module.exports = { AUDITOR_STAGES, SHARED_STAGES, STAGES, phoneDifference, pooledTable, runSummary, stageTable };

// --- command line -----------------------------------------------------------

const seconds = (ms) => (ms / 1000).toFixed(2);
const NAMES = Object.freeze({ mac: 'A. Auditor on the Mac', mobile: 'B. Auditor on the phone' });
const statsHead = ['| Stage | n | Min | Median | Mean | p95 | Max |', '|---|---|---|---|---|---|---|'];
const statsLine = (line) => `| ${line.label.trim()} | ${line.n} | ${seconds(line.min)} | ${seconds(line.median)} | ${seconds(line.mean)} | ${seconds(line.p95)} | ${seconds(line.max)} |`;

function markdown({ halves, pooled, difference, endChecks }) {
  const lines = ['# End-to-end experiment: results', '',
    'Times are in seconds. They use workflows that completed, passed every check and had usable advice from the model.',
    'The median and the 95th percentile use the nearest rank.', '',
    '## Workflows', '',
    '| Kind of workflow | Planned | Completed and verified | Used for the times | Decided without usable advice | Failed a check | Failed | Granted | Denied | Advice matched the written policy | Ledger checks passed |',
    '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const half of halves) {
    const s = half.summary;
    lines.push(`| ${NAMES[half.config]} | ${s.planned} | ${s.completed} | ${s.timed} | ${s.noUsableAdvice} | ${s.checkFailed} | ${s.failed} | ${s.granted} | ${s.denied} | ${s.adviceMatchesPolicy} of ${s.adviceCompared} | ${s.ledgerChecksPassed} of ${s.ledgerChecksMade} |`);
  }
  lines.push('', '## Steps that run on the Mac whoever the auditor is (all workflows together)', '', ...statsHead, ...pooled.map(statsLine));
  if (difference.length) {
    const label = (key) => STAGES.find((stage) => stage.key === key).label.trim();
    lines.push('', '## The auditor\'s steps: phone against Mac (medians)', '', '| Stage | Mac | Phone | Phone minus Mac |', '|---|---|---|---|');
    difference.forEach((line) => lines.push(`| ${label(line.key)} | ${seconds(line.macMedian)} | ${seconds(line.phoneMedian)} | ${line.differenceMs >= 0 ? '+' : ''}${seconds(line.differenceMs)} |`));
  }
  for (const half of halves) lines.push('', `## All stages: ${NAMES[half.config]}`, '', ...statsHead, ...half.table.map(statsLine));
  lines.push('', '## Checks after the run', '');
  endChecks.forEach((check) => lines.push(`- ${check.ok ? 'PASS' : 'FAIL'}: ${check.name} (${check.detail})`));
  return `${lines.join('\n')}\n`;
}

function main() {
  const read = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index === -1 ? fallback : process.argv[index + 1]; };
  const run = read('run');
  const out = read('out');
  const tables = read('tables');
  const prefix = `${read('date')}_${read('name', 'e2e')}`;
  const rows = fs.readFileSync(path.join(run, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const meta = JSON.parse(fs.readFileSync(path.join(run, 'run.json'), 'utf8'));
  const halves = ['mac', 'mobile'].map((config) => {
    const own = rows.filter((row) => row.config === config);
    const planned = (meta.order || []).filter((id) => id.includes(config === 'mac' ? '-MAC-' : '-MOB-')).length;
    return { config, table: stageTable(own), summary: runSummary(own, { planned }) };
  }).filter((half) => half.summary.planned > 0);
  const tableFor = (config) => (halves.find((half) => half.config === config) || { table: [] }).table;
  const pooled = pooledTable(rows);
  const difference = phoneDifference(tableFor('mac'), tableFor('mobile'));

  const stageCsv = ['workflows,stage,n,min_ms,median_ms,mean_ms,p95_ms,max_ms'];
  const csvLine = (who) => (line) => stageCsv.push([who, `"${line.label.trim()}"`, line.n, line.min, line.median, line.mean, line.p95, line.max].join(','));
  pooled.forEach(csvLine('all'));
  halves.forEach((half) => half.table.forEach(csvLine(half.config)));
  const keys = Object.keys(halves[0].summary).filter((key) => key !== 'failedStages');
  const summaryCsv = [['workflows', ...keys].join(','), ...halves.map((half) => [half.config, ...keys.map((key) => half.summary[key])].join(','))];
  const differenceCsv = ['stage,mac_median_ms,phone_median_ms,phone_minus_mac_ms',
    ...difference.map((line) => [line.key, line.macMedian, line.phoneMedian, line.differenceMs].join(','))];

  fs.writeFileSync(path.join(tables, `${prefix}_stage_latency.csv`), `${stageCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(tables, `${prefix}_summary.csv`), `${summaryCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(tables, `${prefix}_phone_vs_mac.csv`), `${differenceCsv.join('\n')}\n`);
  fs.writeFileSync(path.join(out, 'analysis.json'), `${JSON.stringify({ halves, pooled, difference }, null, 1)}\n`);
  const text = markdown({ halves, pooled, difference, endChecks: meta.endChecks || [] });
  fs.writeFileSync(path.join(out, 'RESULTS.md'), text);
  process.stdout.write(text);
}

if (require.main === module) main();
