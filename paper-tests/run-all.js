'use strict';

/**
 * Runs the four paper experiments in order.
 *
 * The frozen configuration is verified once, before anything runs. If the system
 * differs from the baseline the run stops and reports every difference; nothing
 * is reconfigured automatically, because a silent fix would make the results
 * incomparable with the rest of the evaluation.
 *
 * Experiments 01 and 02 are offline and cheap. Experiments 03 and 04 drive the
 * live network and take tens of minutes.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { preflight, metadata, writeJson, banner, RESULTS } = require('./common');

const EXPERIMENTS = [
  { id: '01', file: '01-model-context.js', name: 'model effectiveness and subject context', live: false },
  { id: '02', file: '02-safety-xai.js', name: 'validator safety and explanation correctness', live: false },
  { id: '03', file: '03-security-e2e-reliability.js', name: 'security, end-to-end and reliability', live: true },
  { id: '04', file: '04-performance.js', name: 'latency decomposition and concurrency', live: true },
];

(async () => {
  banner('SEAL paper experiments');

  const only = process.argv.slice(2).filter((a) => /^0[1-4]$/.test(a));
  const selected = only.length ? EXPERIMENTS.filter((e) => only.includes(e.id)) : EXPERIMENTS;

  let pre;
  try {
    pre = await preflight({ requirePending: 0 });
  } catch (error) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(2);
  }
  process.stdout.write(
    `  frozen baseline ${pre.provenance.frozenBaseline} (${pre.provenance.frozenBaselineTag})\n`
    + `  harness commit ${pre.provenance.harnessCommit}\n`
    + `  tag           ${pre.provenance.frozenBaselineTag || '(none)'}\n`
    + `  tree          ${pre.provenance.treeHash}${pre.provenance.dirty ? ' (DIRTY)' : ' (clean)'}\n`
    + `  pending       ${pre.live.pending}\n`
    + `  model         ${pre.live.model.modelVersion}\n`
    + `  policy        ${pre.live.activePolicy.version}\n`
  );
  pre.notes.forEach((n) => process.stdout.write(`  note: ${n}\n`));

  const outcomes = [];
  for (const exp of selected) {
    process.stdout.write(`\n${'-'.repeat(72)}\n  EXPERIMENT ${exp.id}: ${exp.name}\n${'-'.repeat(72)}\n`);
    const started = Date.now();
    const proc = spawnSync('node', [path.join(__dirname, exp.file)], {
      stdio: 'inherit', cwd: path.resolve(__dirname, '..'),
    });
    outcomes.push({
      id: exp.id,
      name: exp.name,
      live: exp.live,
      exitCode: proc.status,
      passed: proc.status === 0,
      durationMs: Date.now() - started,
    });
    // A failed experiment is recorded and the run continues; failures are
    // evidence too, and stopping here would hide the ones that come after.
    if (proc.status !== 0) {
      process.stdout.write(`\n  EXPERIMENT ${exp.id} EXITED NON-ZERO (${proc.status}) — recorded, continuing\n`);
    }
  }

  writeJson('00-run-all', {
    metadata: metadata('RUN-ALL', { selected: selected.map((e) => e.id) }),
    summary: {
      experiments: outcomes.length,
      passed: outcomes.filter((o) => o.passed).length,
      failed: outcomes.filter((o) => !o.passed).length,
      allPassed: outcomes.every((o) => o.passed),
    },
    runs: outcomes,
  });

  process.stdout.write(`\n${'='.repeat(72)}\n`);
  outcomes.forEach((o) => process.stdout.write(
    `  ${o.id}  ${o.passed ? 'PASS' : 'FAIL'}  ${Math.round(o.durationMs / 1000)}s  ${o.name}\n`
  ));
  process.stdout.write(`  results in ${path.relative(process.cwd(), RESULTS)}\n`);
  process.exit(outcomes.every((o) => o.passed) ? 0 : 1);
})();
