#!/usr/bin/env node
'use strict';

/**
 * Build the figures and tables for one or more evaluation runs.
 *
 * Reads `metrics.json` from each run directory. It runs no inference, so every
 * artifact can be regenerated from evidence that already exists.
 *
 *   node experiments/dias-finetuning/v2/eval/report.js \
 *     --runs untuned=experiments/runs/..._baseline,v7=experiments/runs/..._v7 \
 *     --plots results/plots/dias --tables results/tables
 */

const fs = require('fs');
const path = require('path');

const { confusionGrid, groupedBars, latencyChart, lossCurve } = require('./plots');
const { PALETTE } = require('./plots');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (process.argv[i] === undefined) break;
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith('--') ? true : (i += 1, next);
  }
  return args;
}

function loadRuns(spec) {
  return spec.split(',').map((entry, index) => {
    const [label, dir] = entry.split('=');
    const file = path.resolve(dir, 'metrics.json');
    if (!fs.existsSync(file)) throw new Error(`no metrics.json in ${dir}`);
    return {
      label,
      dir,
      report: JSON.parse(fs.readFileSync(file, 'utf8')),
      colour: PALETTE.series[index % PALETTE.series.length],
    };
  });
}

/** Validation loss points, parsed from a training log if one is present. */
function validationCurve(runDir) {
  const log = path.join(runDir, 'training.log');
  if (!fs.existsSync(log)) return [];
  return [...fs.readFileSync(log, 'utf8').matchAll(/Iter (\d+): Val loss ([\d.]+)/g)]
    .map((m) => ({ iteration: Number(m[1]), loss: Number(m[2]) }));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runs) throw new Error('--runs label=dir[,label=dir...] is required');
  const runs = loadRuns(args.runs);
  const plotDir = path.resolve(args.plots || 'results/plots/dias');
  const tableDir = path.resolve(args.tables || 'results/tables');
  fs.mkdirSync(plotDir, { recursive: true });
  fs.mkdirSync(tableDir, { recursive: true });

  const sets = [...new Set(runs.flatMap((r) => Object.keys(r.report.sets)))]
    .filter((set) => runs.every((r) => r.report.sets[set]))
    .sort();
  if (sets.length === 0) throw new Error('the runs share no evaluated set');

  const written = [];
  const write = (name, svg) => {
    fs.writeFileSync(path.join(plotDir, name), `${svg}\n`);
    written.push(path.join(path.relative(process.cwd(), plotDir), name));
  };

  const shortSet = (set) => set.replace(/^test-/, '').replace(/-balanced$/, '');
  const series = runs.map((r) => ({ label: r.label, colour: r.colour, run: r }));

  write('decision-accuracy.svg', groupedBars({
    title: 'Decision accuracy on schema-valid responses',
    groups: sets.map(shortSet),
    series,
    value: (entry, group) => entry.run.report.sets[
      sets.find((s) => shortSet(s) === group)].decisionAccuracy,
    yLabel: 'accuracy',
  }));

  write('balanced-accuracy.svg', groupedBars({
    title: 'Balanced accuracy (mean of the two recalls)',
    groups: sets.map(shortSet),
    series,
    value: (entry, group) => entry.run.report.sets[
      sets.find((s) => shortSet(s) === group)].balancedAccuracy,
    yLabel: 'balanced accuracy',
  }));

  write('false-allow-rate.svg', groupedBars({
    title: 'False ALLOW rate — the safety guardrail (lower is better)',
    groups: sets.map(shortSet),
    series,
    value: (entry, group) => entry.run.report.sets[
      sets.find((s) => shortSet(s) === group)].falseAllow.ofDenyExamples,
    yLabel: 'false ALLOW / DENY examples',
    max: 0.5,
  }));

  write('schema-validity.svg', groupedBars({
    title: 'Schema-valid responses',
    groups: sets.map(shortSet),
    series,
    value: (entry, group) => entry.run.report.sets[
      sets.find((s) => shortSet(s) === group)].schemaValidRate,
    yLabel: 'valid fraction',
  }));

  const latencySet = sets.includes('test-decision-balanced') ? 'test-decision-balanced' : sets[0];
  write('latency.svg', latencyChart({
    title: `Inference latency — ${latencySet}`,
    series: runs.map((r) => ({
      label: r.label, colour: r.colour, latency: r.report.sets[latencySet].latencyMs,
    })),
  }));

  for (const run of runs) {
    const m = run.report.sets[latencySet];
    write(`confusion-${run.label}.svg`, confusionGrid({
      title: `${run.label} — ${latencySet}`,
      matrix: m.confusionMatrix,
      invalid: m.invalid,
    }));
    const curve = validationCurve(run.dir);
    if (curve.length >= 2) {
      write(`validation-loss-${run.label}.svg`, lossCurve({
        title: `${run.label} — validation loss`, points: curve,
      }));
    }
  }

  // Error categories, which turn a number into a diagnosis.
  const rows = [['set', 'model', 'category', 'count']];
  for (const set of sets) {
    for (const run of runs) {
      for (const [category, count] of Object.entries(run.report.sets[set].errorCategories || {})) {
        rows.push([set, run.label, category, count]);
      }
    }
  }
  const errorTable = path.join(tableDir, 'dias_error_categories.csv');
  fs.writeFileSync(errorTable, `${rows.map((r) => r.join(',')).join('\n')}\n`);

  console.log(`models: ${runs.map((r) => r.label).join(', ')}`);
  console.log(`sets:   ${sets.join(', ')}`);
  console.log(`\nfigures:`);
  for (const file of written) console.log(`  ${file}`);
  console.log(`tables:\n  ${path.relative(process.cwd(), errorTable)}`);
}

if (require.main === module) main();
module.exports = { validationCurve };
