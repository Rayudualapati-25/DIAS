#!/usr/bin/env node
'use strict';

/**
 * Build the result tables of the offline integrity experiment from its run
 * files. Reads every seed-* directory of a run; writes CSV files only.
 *
 *   node experiments/v3/integrity-tables.js \
 *     --run experiments/runs/20261009_v3_integrity_offline --prefix results/tables/20261009_v3_integrity
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!args.run || !args.prefix) throw new Error('--run <dir> and --prefix <path prefix> are required');
  return args;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (value, digits = 3) => (typeof value === 'number' ? Number(value.toFixed(digits)) : value);
const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
function writeCsv(file, header, rows) {
  fs.writeFileSync(file, `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`);
  console.log(`wrote ${file} (${rows.length} rows)`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seeds = fs.readdirSync(args.run).filter((name) => name.startsWith('seed-')).sort();
  if (!seeds.length) throw new Error(`no seed-* directories in ${args.run}`);
  const read = (seed, name) => JSON.parse(fs.readFileSync(path.join(args.run, seed, name), 'utf8'));
  const label = seeds.map((seed) => seed.replace('seed-', '')).join(' ');
  const kind = 'offline microbenchmark / mock Fabric stub; not a live Fabric result';

  // Latency of the integrity primitives.
  const latency = seeds.map((seed) => read(seed, 'latency.json'));
  writeCsv(`${args.prefix}_latency.csv`,
    ['operation', 'input_bytes', 'iterations_per_seed', 'p50_us_median_of_seeds', 'p50_us_min_seed', 'p50_us_max_seed', 'p95_us_median_of_seeds', 'p99_us_median_of_seeds', 'seeds', 'kind'],
    latency[0].map((row, index) => {
      const p50 = latency.map((run) => run[index].p50);
      return [row.operation, row.inputBytes, row.n, fmt(median(p50)), fmt(Math.min(...p50)), fmt(Math.max(...p50)),
        fmt(median(latency.map((run) => run[index].p95))), fmt(median(latency.map((run) => run[index].p99))), label, kind];
    }));

  // Write set and contract execution per workflow, v2 against v3.
  const workflows = seeds.map((seed) => read(seed, 'workflows.json'));
  const rows = [];
  for (const [index, row] of workflows[0].entries()) {
    const bytes = workflows.map((run) => run[index].totalWriteSetBytes);
    const execution = workflows.map((run) => run[index].totalExecutionMs.p50);
    const v2 = row.version === 'v3' ? workflows[0].find((item) => item.version === 'v2' && item.workflow === row.workflow) : null;
    const delta = v2 ? row.totalWriteSetBytes.max - v2.totalWriteSetBytes.max : null;
    rows.push([row.version, row.workflow, row.label, row.transactions,
      Math.min(...bytes.map((b) => b.min)), Math.max(...bytes.map((b) => b.max)),
      delta, v2 ? fmt((100 * delta) / v2.totalWriteSetBytes.max, 1) : null,
      fmt(median(execution)), fmt(Math.min(...execution)), fmt(Math.max(...execution)),
      row.repetitions, label, kind]);
  }
  writeCsv(`${args.prefix}_workflow_storage.csv`,
    ['version', 'workflow', 'description', 'transactions', 'write_set_bytes_min', 'write_set_bytes_max', 'v3_minus_v2_bytes', 'v3_minus_v2_percent',
      'contract_exec_ms_p50_median_of_seeds', 'contract_exec_ms_p50_min_seed', 'contract_exec_ms_p50_max_seed', 'repetitions_per_seed', 'seeds', 'kind'],
    rows);

  // The same, per transaction and object type, for the first seed (bytes are seed-independent).
  const typeRows = [];
  for (const row of workflows[0]) {
    for (const transaction of row.perTransaction) {
      for (const [type, bytes] of Object.entries(transaction.writeSetBytesByType)) {
        typeRows.push([row.version, row.workflow, transaction.name, type, bytes]);
      }
    }
  }
  writeCsv(`${args.prefix}_write_set_by_type.csv`, ['version', 'workflow', 'transaction', 'state_object_type', 'key_plus_value_bytes'], typeRows);

  // Tamper detection, summed over seeds.
  const tamper = seeds.map((seed) => read(seed, 'tamper.json'));
  const merged = new Map();
  for (const run of tamper) {
    for (const row of run.rows) {
      const key = `${row.group}|${row.mutation}`;
      const into = merged.get(key) || { ...row, trials: 0, detected: 0, detectedByDigestOnly: 0, detectedByFieldBindingOnly: 0, flaggedByNaiveHash: 0 };
      for (const field of ['trials', 'detected', 'detectedByDigestOnly', 'detectedByFieldBindingOnly', 'flaggedByNaiveHash']) {
        into[field] += row[field] || 0;
      }
      merged.set(key, into);
    }
  }
  const hasAblation = (row) => row.group.startsWith('recommendation object');
  writeCsv(`${args.prefix}_tamper_detection.csv`,
    ['object', 'mutation', 'content_changed', 'trials', 'detected', 'detection_rate', 'digest_only_rate', 'field_binding_only_rate', 'naive_noncanonical_hash_flag_rate', 'seeds', 'kind'],
    [...merged.values()].map((row) => [row.group, row.mutation, row.expectedChange, row.trials, row.detected, fmt(row.detected / row.trials, 4),
      hasAblation(row) ? fmt(row.detectedByDigestOnly / row.trials, 4) : null,
      hasAblation(row) ? fmt(row.detectedByFieldBindingOnly / row.trials, 4) : null,
      hasAblation(row) ? fmt(row.flaggedByNaiveHash / row.trials, 4) : null, label, kind]));

  // Policy-update invalidation (structure is seed-independent; checked on every seed).
  const policies = seeds.map((seed) => read(seed, 'policy-invalidation.json'));
  const same = policies.every((run) => JSON.stringify(run.v3) === JSON.stringify(policies[0].v3)
    && JSON.stringify(run.v2Baseline) === JSON.stringify(policies[0].v2Baseline));
  if (!same) throw new Error('policy-invalidation results differ between seeds; inspect before tabulating');
  const v3 = policies[0].v3;
  const policyRows = [
    ['reuse of an authorization issued under the old policy', v3.reuseOfOldAuthorization.total, v3.reuseOfOldAuthorization.refused, v3.reuseOfOldAuthorization.missReasons.join(' '), policies[0].v2Baseline.reuseContinues],
    ['auditor decision on a pending request with κ', v3.decisionOnPendingRequestWithKappa.total, v3.decisionOnPendingRequestWithKappa.refused, 'DIAS_STALE_POLICY', 'n/a (v2 has no policy input)'],
    ['κ commit on a pending request', v3.kappaCommitOnPendingRequest.total, v3.kappaCommitOnPendingRequest.refused, 'DIAS_STALE_POLICY', 'n/a (no κ in v2)'],
    ['document release of a reviewed grant', v3.releaseOfReviewedGrant.total, v3.releaseOfReviewedGrant.refused, 'DIAS_STALE_POLICY', 'not measured'],
    ['document release of a reused grant', v3.releaseOfReusedGrant.total, v3.releaseOfReusedGrant.refused, 'DIAS_STALE_POLICY', 'not measured'],
    ['expiry of a pending request after the change (should succeed)', v3.expiryOfPendingRequest.total, v3.expiryOfPendingRequest.refused, 'accepted', 'n/a'],
    ['reissue under the new policy (should succeed; old one superseded)', v3.reissueUnderNewPolicy.total, v3.reissueUnderNewPolicy.total - v3.reissueUnderNewPolicy.ok, `old status ${v3.reissueUnderNewPolicy.oldStatuses.join(' ')}; generation ${v3.reissueUnderNewPolicy.newGenerations.join(' ')}`, 'n/a'],
  ];
  writeCsv(`${args.prefix}_policy_invalidation.csv`,
    ['item_after_policy_change', 'v3_total', 'v3_refused', 'v3_reason_or_result', 'v2_baseline_still_accepted', 'seeds', 'kind'],
    policyRows.map((row) => [...row, label, kind]));

  // End-to-end v3 path through the backend runtime.
  const endToEnd = seeds.map((seed) => read(seed, 'end-to-end.json'));
  writeCsv(`${args.prefix}_end_to_end.csv`,
    ['measure', 'p50_median_of_seeds', 'p50_min_seed', 'p50_max_seed', 'p95_median_of_seeds', 'repetitions_per_seed', 'seeds', 'kind'],
    Object.keys(endToEnd[0].summary).map((measure) => {
      const p50 = endToEnd.map((run) => run.summary[measure].p50);
      return [measure, fmt(median(p50)), fmt(Math.min(...p50)), fmt(Math.max(...p50)),
        fmt(median(endToEnd.map((run) => run.summary[measure].p95))), endToEnd[0].repetitions, label,
        'backend runtime + stand-in model on localhost + mock Fabric stub; not a live Fabric or model result'];
    }));
}

main();
