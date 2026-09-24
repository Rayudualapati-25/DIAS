#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const sha256 = (relative) => crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(root, relative))).digest('hex');
const required = (relative) => {
  const file = path.join(root, relative);
  assert.ok(fs.existsSync(file), `missing ${relative}`);
  assert.ok(fs.statSync(file).size > 0, `empty ${relative}`);
  return { path: relative, bytes: fs.statSync(file).size, sha256: sha256(relative) };
};

const figures = [
  '01_recommendation_quality',
  '02_scope_safety_efficiency',
  '03_concurrent_user_latency_throughput',
  '04_model_failure_unsafe_allow',
].flatMap((stem) => ['png', 'pdf'].map((extension) =>
  required(`results/plots/dias-overnight/${stem}.${extension}`)));

const baseline = readJson('experiments/runs/20260912_dias_qwen3_baseline/metrics.json')
  .sets['test-decision-balanced'];
const v7 = readJson('experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval/metrics.json')
  .sets['test-decision-balanced'];
assert.equal(baseline.examples, 600);
assert.equal(v7.examples, 600);
assert.ok(v7.balancedAccuracy > baseline.balancedAccuracy);
assert.equal(v7.falseAllow.count, 6);
assert.equal(v7.falseDeny.count, 2);

const failure = readJson('results/tables/dias_v7_unsafe_allow_failures.json');
assert.equal(failure.policyDeniedAdversarialExamples, 204);
assert.equal(failure.unsafeAllows, 6);
assert.equal(failure.highlightedFailure.exampleId, 'EX-f83b18dd09da');
assert.equal(failure.highlightedFailure.predicted.recommendation, 'ALLOW');
assert.equal(failure.highlightedFailure.expected.recommendation, 'DENY');

const concurrency = readJson('experiments/runs/20260916_dias_concurrent_users/concurrent-users.json');
assert.deepEqual(concurrency.summary.map((row) => row.concurrentUsers), [1, 2, 4, 8, 12]);
assert.equal(concurrency.summary.reduce((sum, row) => sum + row.completed, 0), 81);
assert.equal(concurrency.summary.reduce((sum, row) => sum + row.failures.length, 0), 0);

const scope = readJson('experiments/runs/20260916_dias_scope_workload_sweep/scope-workload-sweep.json');
assert.equal(scope.cells.length, 48);
assert.equal(scope.cells.filter((cell) => cell.design === 'exact-record')
  .reduce((sum, cell) => sum + cell.automaticGrantsOnADifferentRecord, 0), 0);
assert.ok(scope.cells.filter((cell) => cell.design === 'property-fingerprint')
  .some((cell) => cell.automaticGrantsOnADifferentRecord > 0));

const acceptance = readJson('experiments/runs/20260916_dias_v7_live_acceptance_r3/acceptance.json');
assert.deepEqual(acceptance.summary, { pass: 14, fail: 0, notExercised: 0, total: 14 });
const checks = acceptance.scenarios.flatMap((scenario) => scenario.checks);
assert.equal(checks.length, 81);
assert.equal(checks.filter((check) => check.ok).length, 81);

const review = readJson('experiments/runs/20260916_dias_overnight_live/reviews/REQ-377c31f1e7f2e89b.json');
assert.equal(review.recommendation.provenance.modelId, 'qwen3-14b-dias-v7');
assert.equal(review.recommendation.provenance.adapterHash,
  '348f4ca5707e35afda2b35522ab6bb7c0527d84be23de80253a0c358ae1fd43d');

const audit = readJson('experiments/runs/20260916_dias_audit_reconstruction/audit-reconstruction.json');
assert.deepEqual(audit.summary, { cases: 7, completelyReconstructed: 7, completenessRate: 1 });

const expanded = readJson('experiments/runs/20260917_dias_expanded_adversarial/metrics.json')
  .sets['adversarial-expanded'];
assert.equal(expanded.examples, 120);
assert.equal(expanded.schemaValid, 120);
assert.equal(expanded.falseAllow.count, 0);
assert.equal(Object.keys(expanded.byJustificationKind).length, 6);

const seeds = [17, 42, 73].map((seed) => {
  const training = readJson(`experiments/runs/20260916_dias_seed_pilot/seed-${seed}/training/run.json`);
  const metric = readJson(`experiments/runs/20260916_dias_seed_pilot/seed-${seed}/evaluation/metrics.json`)
    .sets['validation-balanced'];
  assert.equal(training.status, 'completed');
  assert.equal(training.v6AdapterIntactAfterRun, true);
  assert.equal(metric.examples, 120);
  assert.equal(metric.schemaValid, 120);
  return { seed, adapterHash: training.finalAdapterSha256, balancedAccuracy: metric.balancedAccuracy };
});

const supporting = [
  'results/tables/dias_concurrent_users.csv',
  'results/tables/dias_scope_workload_sweep.csv',
  'results/tables/dias_audit_reconstruction.csv',
  'results/tables/dias_expanded_adversarial_summary.json',
  'results/tables/dias_seed_pilot_summary.json',
  'experiments/plans/20260916_dias_overnight_campaign.md',
  'reports/iteration/iter_052_dias_overnight_experiments.md',
  'DIAS latex paper/sections/Results.tex',
  'papers/final_paper/results.tex',
  'output/pdf/DIAS_Overnight_Results_20260917.pdf',
  'output/pdf/dias_paper_overnight_20260917.pdf',
].map(required);

const outputDir = path.join(root, 'experiments/runs/20260917_dias_overnight_summary');
fs.mkdirSync(outputDir, { recursive: true });
const report = {
  artifactType: 'dias-overnight-verification',
  verifiedAtUtc: new Date().toISOString(),
  status: 'PASS',
  checks: {
    figureFiles: figures.length,
    recommendationBaselineAndV7: true,
    crossedFailureSource: true,
    measuredConcurrentWorkflows: 81,
    concurrentFailures: 0,
    scopeCells: scope.cells.length,
    acceptanceScenarios: acceptance.summary.pass,
    acceptanceChecks: checks.length,
    auditCases: audit.summary.completelyReconstructed,
    expandedAdversarialExamples: expanded.examples,
    expandedAdversarialFalseAllows: expanded.falseAllow.count,
    seedPilots: seeds.length,
  },
  figures,
  supporting,
  seeds,
};
fs.writeFileSync(path.join(outputDir, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, checks: report.checks }));
