'use strict';

/**
 * Read-only pre-submission gate for the interactive-latency evidence chain.
 *
 * It recomputes the reported latency summaries from retained per-request
 * samples, validates run and figure manifests, checks the published table
 * copies, and confirms that the current manuscript carries the measured
 * values with the required scope qualifications.
 *
 * Usage: node experiments/verify-ui-latency-artifacts.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_RUN = path.join(
  ROOT, 'experiments', 'runs', '2026-08-25T14-07-26-224Z_ui_interaction_latency');
const CORRECTED_RUN = path.join(
  ROOT, 'experiments', 'runs', '2026-08-25T14-12-11-482Z_ui_interaction_latency');
const TABLE_DIR = path.join(ROOT, 'results', 'tables', 'ui-latency');
const PLOT_DIR = path.join(ROOT, 'results', 'plots', 'ui-latency');
const MANUSCRIPT = path.join(
  ROOT, 'output', 'overleaf', 'SEBA_XAI_Overleaf_Package', 'main.tex');
const PAPER_FIGURE = path.join(
  ROOT, 'output', 'overleaf', 'SEBA_XAI_Overleaf_Package', 'figures', 'results',
  'interactive_latency_three_panel.pdf');
const GATEWAY_SOURCE = path.join(ROOT, 'backend', 'src', 'fabric', 'gateway.js');

let failures = 0;

function relative(filePath) {
  return path.relative(ROOT, filePath);
}

function check(condition, description) {
  process.stdout.write(`${condition ? 'PASS' : 'FAIL'}  ${description}\n`);
  if (!condition) failures += 1;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function identical(left, right) {
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function rounded(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null : Number(value.toFixed(2));
}

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1)];
}

function sampleStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length
    ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    : null;
  return {
    minMs: rounded(sorted[0]),
    p50Ms: rounded(percentile(sorted, 0.50)),
    meanMs: rounded(mean),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function equalMetric(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) < 0.005;
}

function verifyRun(runDir) {
  const report = readJson(path.join(runDir, 'run-report.json'));
  const samples = readJsonLines(path.join(runDir, 'raw-samples.jsonl'));
  const manifest = readJson(path.join(runDir, 'artifact-manifest.json'));

  check(samples.length === report.totals.attempted,
    `${relative(runDir)} raw sample count matches report total`);
  check(samples.filter((sample) => sample.ok).length === report.totals.successful,
    `${relative(runDir)} success count matches report total`);

  for (const row of report.summary) {
    const matching = samples.filter((sample) => sample.operation === row.operation
      && sample.concurrentSessions === row.concurrentSessions);
    const successful = matching.filter((sample) => sample.ok);
    const recomputed = sampleStats(successful.map((sample) => sample.elapsedMs));
    check(matching.length === row.attempted
      && successful.length === row.successful
      && matching.length - successful.length === row.failed,
    `${report.runId} ${row.operation} N=${row.concurrentSessions} counts recompute`);
    check(Object.entries(recomputed).every(([name, value]) => equalMetric(value, row[name])),
      `${report.runId} ${row.operation} N=${row.concurrentSessions} latency recomputes`);
  }

  for (const [name, expected] of Object.entries(manifest.artifacts)) {
    const artifact = path.join(runDir, name);
    check(fs.existsSync(artifact), `${report.runId} manifest file exists: ${name}`);
    if (!fs.existsSync(artifact)) continue;
    check(fs.statSync(artifact).size === expected.bytes,
      `${report.runId} manifest byte count matches: ${name}`);
    check(sha256(artifact) === expected.sha256,
      `${report.runId} manifest digest matches: ${name}`);
  }

  return { report, samples };
}

function verifyFigures(correctedReport) {
  const manifestPath = path.join(PLOT_DIR, 'figure-manifest.json');
  const manifest = readJson(manifestPath);
  check(manifest.generatedFrom === path.join(
    'experiments', 'runs', correctedReport.runId, 'run-report.json'),
  'figure manifest uses a repository-relative source path');
  check(manifest.inputSha256 === sha256(path.join(CORRECTED_RUN, 'run-report.json')),
    'figure manifest input digest matches the corrected run report');
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    const figure = path.join(PLOT_DIR, name);
    check(fs.existsSync(figure), `figure exists: ${name}`);
    if (!fs.existsSync(figure)) continue;
    check(fs.statSync(figure).size === expected.bytes, `figure byte count matches: ${name}`);
    check(sha256(figure) === expected.sha256, `figure digest matches: ${name}`);
  }
  check(sha256(PAPER_FIGURE) === sha256(path.join(
    PLOT_DIR, 'interactive_latency_three_panel.pdf')),
  'paper package contains the verified three-panel figure');
}

function verifyManuscript() {
  const manuscript = fs.readFileSync(MANUSCRIPT, 'utf8');
  const normalizedManuscript = manuscript.replace(/\s+/g, ' ');
  const section = normalizedManuscript.split('\\subsection{Interactive latency}')[1]
    .split('\\section{Limitations and Conclusion}')[0];
  const required = [
    'all 2,340 requests succeeded',
    '41.77\\,ms', '122.67\\,ms', '58.35', '157.30\\,ms',
    '115.64', '396.35\\,ms', '141.69', '583.30\\,ms',
    '49.35', '154.28\\,ms', '60.98', '181.26\\,ms',
    'three batches', 'pre-existing grant',
  ];
  for (const phrase of required) {
    check(section.includes(phrase), `manuscript latency section contains: ${phrase}`);
  }
  check(!section.includes('verified its use on all five peer databases'),
    'manuscript does not assert unretained per-peer index inspection');
  check(!section.includes('through policy evaluation'),
    'manuscript does not mislabel the pre-existing grant check as policy evaluation');
  check(!normalizedManuscript.includes('2,340 indexed interaction-study'),
    'manuscript does not label every measured path as CouchDB-indexed');
  check(normalizedManuscript.includes('single-host'),
    'manuscript identifies the latency deployment as single-host');
}

process.stdout.write('Interactive-latency paper evidence verification\n');
process.stdout.write('='.repeat(48) + '\n');

const baseline = verifyRun(BASELINE_RUN);
const corrected = verifyRun(CORRECTED_RUN);

check(corrected.report.totals.attempted === 2340
  && corrected.report.totals.successful === 2340
  && corrected.report.totals.failed === 0,
'corrected run reports 2,340/2,340 successful requests');
check(identical(path.join(CORRECTED_RUN, 'run-report.json'),
  path.join(TABLE_DIR, 'run-report.json')), 'published run report is an exact retained copy');
check(identical(path.join(CORRECTED_RUN, 'summary.csv'),
  path.join(TABLE_DIR, 'summary.csv')), 'published summary table is an exact retained copy');
check(identical(path.join(CORRECTED_RUN, 'rounds.csv'),
  path.join(TABLE_DIR, 'rounds.csv')), 'published rounds table is an exact retained copy');
check(identical(path.join(BASELINE_RUN, 'summary.csv'),
  path.join(TABLE_DIR, 'baseline-unindexed-search-summary.csv')),
'unindexed diagnostic table is an exact retained copy');

const failedBaseline = baseline.samples.filter((sample) => !sample.ok);
check(failedBaseline.length === 25
  && failedBaseline.every((sample) => sample.status === 500)
  && Math.min(...failedBaseline.map((sample) => sample.elapsedMs)) >= 5000,
'unindexed N=25 diagnostic retains 25 HTTP 500 responses after five seconds');
check(fs.readFileSync(GATEWAY_SOURCE, 'utf8')
  .includes('evaluateOptions: () => ({ deadline: Date.now() + 5000 })'),
'backend source records the five-second Fabric evaluation deadline');

verifyFigures(corrected.report);
verifyManuscript();

process.stdout.write('-'.repeat(48) + '\n');
if (failures > 0) {
  process.stderr.write(`${failures} verification check(s) failed; do not cite this build.\n`);
  process.exit(1);
}
process.stdout.write('All checks passed. The retained latency evidence is internally consistent.\n');
