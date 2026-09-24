'use strict';
/**
 * Reproduction material for Figure 3 of
 * papers/final_paper/SEBA_XAI_ACM_6page.tex
 *
 * Figure 3 is drawn in TikZ inside the manuscript rather than imported as a
 * raster or vector file, so "reproducing" it means regenerating the numbers it
 * plots and confirming the manuscript still carries exactly those numbers.
 *
 * Every value is read from the recorded measurement artifact; nothing is
 * recomputed from a live network and nothing is hard-coded here.
 *
 * Source of truth:
 *   experiments/results/live_fabric_measurements.json
 *
 * What the figure shows, and what it does not:
 *   - an OBSERVED median end-to-end commit latency (buildLatency.aggregate.p50Ms)
 *   - a CONFIGURED batching timeout used as a reference line
 *     (environment.ordererBatchTimeoutMs)
 *   - their DIFFERENCE (buildLatency.marginalP50Ms)
 * The difference is arithmetic between a configuration constant and an observed
 * total. It is not a component timing and carries no causal claim: the run did
 * not instrument API validation, policy evaluation, explanation construction,
 * endorsement, validation, or commit separately.
 *
 * Usage:
 *   node results/plots/figure3_latency_reference.js          # print + verify
 *   node results/plots/figure3_latency_reference.js --tikz   # print TikZ only
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// results/plots -> crime-records-network
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(REPO_ROOT, 'experiments', 'results', 'live_fabric_measurements.json');
const TEX = path.join(REPO_ROOT, 'papers', 'final_paper', 'SEBA_XAI_ACM_6page.tex');

function rel(p) { return path.relative(REPO_ROOT, p); }
function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

if (!fs.existsSync(DATA)) {
  console.error(`error: measurement artifact not found at ${rel(DATA)}`);
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const total = d.buildLatency.aggregate.p50Ms;          // observed
const n = d.buildLatency.aggregate.n;                  // sample count
const timeout = d.environment.ordererBatchTimeoutMs;   // configured constant
const diff = d.buildLatency.marginalP50Ms;             // observed - configured

const tikz = `    \\draw[->] (0,0) -- (2200,0) node[right,note]{ms};
    \\foreach \\x in {0,500,1000,1500,2000}
      \\draw (\\x,0.06) -- (\\x,-0.06) node[below,note]{\\x};
    \\fill[fabricblue!75] (0,0.25) rectangle (${timeout},0.68);
    \\fill[allowgreen!75] (${timeout},0.25) rectangle (${total},0.68);
    \\draw (0,0.25) rectangle (${total},0.68);
    \\node[note, text=white] at (1000,0.465) {configured timeout reference: ${timeout}};
    \\draw[flow, draw=allowgreen] (${total},0.72) -- (${total},1.05)
      node[above,note,align=center]{observed difference\\\\from reference: ${diff}};
    \\node[note, anchor=west] at (0,1.28) {Observed p50 total: ${total} ms (\\(n=${n}\\))};`;

if (process.argv.includes('--tikz')) {
  console.log(tikz);
  process.exit(0);
}

console.log('Figure 3 reproduction — SEBA_XAI_ACM_6page.tex');
console.log('='.repeat(64));
console.log(`data artifact : ${rel(DATA)}`);
console.log(`  sha256      : ${sha256(DATA)}`);
console.log(`  recorded at : ${d.generatedAtUtc}`);
console.log(`manuscript    : ${rel(TEX)}`);
console.log(`  sha256      : ${sha256(TEX)}`);
console.log('');
console.log('Plotted quantities');
console.log(`  observed median total   : ${total} ms   (buildLatency.aggregate.p50Ms, n=${n})`);
console.log(`  configured timeout ref. : ${timeout} ms   (environment.ordererBatchTimeoutMs)`);
console.log(`  observed difference     : ${diff} ms   (buildLatency.marginalP50Ms)`);
console.log('');
console.log(`arithmetic check: ${total} - ${timeout} = ${(total - timeout).toFixed(2)}`
  + `  vs recorded ${diff}  -> `
  + (Math.abs((total - timeout) - diff) < 0.005 ? 'consistent' : 'MISMATCH'));
console.log('');

// Confirm the manuscript still carries these exact values.
if (fs.existsSync(TEX)) {
  const tex = fs.readFileSync(TEX, 'utf8');
  const checks = [
    [`observed median total ${total}`, String(total)],
    [`configured timeout ${timeout}`, String(timeout)],
    [`observed difference ${diff}`, String(diff)],
    ['sample count n=' + n, `n=${n}`],
  ];
  let ok = true;
  console.log('Manuscript consistency');
  for (const [label, needle] of checks) {
    const present = tex.includes(needle);
    if (!present) ok = false;
    console.log(`  ${present ? 'present ' : 'MISSING '} ${label}`);
  }
  console.log('');
  console.log(ok
    ? 'Figure 3 matches the recorded artifact.'
    : 'Figure 3 does NOT match the recorded artifact; do not ship this build.');
  process.exit(ok ? 0 : 1);
}
