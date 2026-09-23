#!/usr/bin/env node
'use strict';

/**
 * Workload-sensitivity extension of the DIAS scope ablation.
 *
 * The existing two-arm replay is the source of truth for exact-record and
 * property-fingerprint behavior.  This runner varies only repetitions and the
 * number of different records sharing governed properties, and adds a no-reuse
 * reference arm.  Every cell is retained as its own normal scope-ablation run.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const ABLATION = path.join(REPO, 'experiments', 'dias-finetuning', 'v2', 'eval', 'scope-ablation.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function csv(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(REPO, args.out || 'experiments/runs/20260916_dias_scope_workload_sweep');
  const seed = Number(args.seed || 20260912);
  const repeats = String(args.repeats || '0,1,3,7').split(',').map(Number);
  const siblings = String(args.siblings || '0,1,2,4').split(',').map(Number);
  if (fs.existsSync(path.join(outDir, 'scope-workload-sweep.json'))) {
    throw new Error(`${path.relative(REPO, outDir)} already contains a completed sweep`);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const cells = [];
  for (const repeatCount of repeats) {
    for (const siblingCount of siblings) {
      const cellDir = path.join(outDir, `repeats-${repeatCount}_siblings-${siblingCount}`);
      const run = spawnSync(process.execPath, [ABLATION,
        '--out', cellDir,
        '--seed', String(seed),
        '--repeats', String(repeatCount),
        '--siblings', String(siblingCount),
      ], { cwd: REPO, encoding: 'utf8' });
      fs.writeFileSync(path.join(cellDir, 'runner.log'), `${run.stdout || ''}${run.stderr || ''}`);
      if (run.status !== 0) throw new Error(`scope cell r=${repeatCount}, s=${siblingCount} failed`);
      const report = JSON.parse(fs.readFileSync(path.join(cellDir, 'scope-ablation.json'), 'utf8'));
      const noReuse = {
        requests: report.stream.requests,
        modelInvocations: report.stream.requests,
        auditorReviews: report.stream.requests,
        authorizationsCreated: 0,
        automaticGrants: 0,
        automaticGrantsOnTheApprovedRecord: 0,
        automaticGrantsOnADifferentRecord: 0,
        recordsPerApproval: {
          approvals: 0, max: 0, mean: 0, approvalsReachingMoreThanOneRecord: 0,
        },
      };
      for (const [design, arm] of Object.entries({
        'no-reuse': noReuse,
        ...report.arms,
      })) {
        cells.push({
          seed,
          repeats: repeatCount,
          siblingsPerCase: siblingCount,
          requests: report.stream.requests,
          distinctRecords: report.stream.distinctRecords,
          design,
          ...arm,
          reviewSavingsRate: Number((1 - (arm.auditorReviews / report.stream.requests)).toFixed(6)),
        });
      }
      process.stdout.write(`completed repeats=${repeatCount} siblings=${siblingCount}\n`);
    }
  }

  const report = {
    artifactType: 'dias-scope-workload-sweep',
    generatedAtUtc: new Date().toISOString(),
    seed,
    repeats,
    siblingsPerCase: siblings,
    method: 'Each cell replays the same deterministic workflow cases and auditor choices through no reuse, exact-record reuse, and property-fingerprint reuse. Only repeat and sibling-record counts vary.',
    cells,
    interpretationBoundary: 'Synthetic replay measures conditional safety and work, not the prevalence of repeat or sibling traffic in production.',
  };
  fs.writeFileSync(path.join(outDir, 'scope-workload-sweep.json'), `${JSON.stringify(report, null, 2)}\n`);

  const headers = [
    'seed', 'repeats', 'siblings_per_case', 'requests', 'distinct_records', 'design',
    'model_invocations', 'auditor_reviews', 'review_savings_rate', 'automatic_grants',
    'grants_on_approved_record', 'grants_on_a_different_record',
    'mean_records_per_approval', 'max_records_per_approval',
  ];
  const rows = cells.map((cell) => [
    cell.seed, cell.repeats, cell.siblingsPerCase, cell.requests, cell.distinctRecords, cell.design,
    cell.modelInvocations, cell.auditorReviews, cell.reviewSavingsRate, cell.automaticGrants,
    cell.automaticGrantsOnTheApprovedRecord, cell.automaticGrantsOnADifferentRecord,
    cell.recordsPerApproval.mean, cell.recordsPerApproval.max,
  ]);
  const csvText = `${[headers, ...rows].map((row) => row.map(csv).join(',')).join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'scope-workload-sweep.csv'), csvText);
  fs.mkdirSync(path.join(REPO, 'results', 'tables'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'results', 'tables', 'dias_scope_workload_sweep.csv'), csvText);
}

main();

