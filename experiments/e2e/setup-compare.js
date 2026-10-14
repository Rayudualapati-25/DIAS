#!/usr/bin/env node
'use strict';

/**
 * The two models of the three-setup experiment side by side. Both answered the same planned requests, so
 * the step experiment is compared request by request.
 */

const fs = require('fs');
const path = require('path');
const { describe, round } = require('./lib');
const { bootstrapDifference, csv } = require('./setup-analyze');
const { generator } = require('./plan');

const MODELS = Object.freeze(['untuned', 'v7']);

const readRows = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

/**
 * The median of paired differences (second minus first) with a seeded 95% bootstrap interval, in the unit
 * of `value`.
 */
function pairedDifference(pairs, value, { draws = 10000, seed = 20261014 } = {}) {
  const differences = pairs.map(([first, second]) => value(second) - value(first)).filter(Number.isFinite);
  if (differences.length === 0) return { n: 0, median: null, low: null, high: null };
  const random = generator(seed);
  const medians = Array.from({ length: draws }, () => describe(Array.from({ length: differences.length },
    () => differences[Math.floor(random() * differences.length)])).median).sort((a, b) => a - b);
  const at = (q) => medians[Math.round(q * (draws - 1))];
  return { n: differences.length, median: describe(differences).median, low: round(at(0.025)), high: round(at(0.975)) };
}

/** How the two models' advice compares on the same live requests, and each against the written policy. */
function adviceAgreement(pairs) {
  const count = (test) => pairs.filter(test).length;
  const both = pairs.filter(([a, b]) => a.advice && b.advice);
  return {
    requests: pairs.length, bothAnswered: both.length,
    sameAdvice: count(([a, b]) => a.advice && a.advice === b.advice),
    untunedMatchesPolicy: count(([a]) => a.adviceMatchesPolicy === true),
    v7MatchesPolicy: count(([, b]) => b.adviceMatchesPolicy === true),
    untunedAllowWherePolicyDenies: count(([a]) => a.advice === 'ALLOW' && a.policyAnswer === 'DENY'),
    v7AllowWherePolicyDenies: count(([, b]) => b.advice === 'ALLOW' && b.policyAnswer === 'DENY'),
    untunedNoUsableAdvice: count(([a]) => !a.advice), v7NoUsableAdvice: count(([, b]) => !b.advice),
  };
}

/** Rows of the step experiment of both models, matched by their planned request. */
function pairSteps(untunedRows, v7Rows) {
  const v7 = new Map(v7Rows.map((row) => [row.id, row]));
  return untunedRows.filter((row) => v7.has(row.id)).map((row) => [row, v7.get(row.id)]);
}

function main() {
  const argv = process.argv.slice(2);
  const read = (name) => (argv.indexOf(`--${name}`) === -1 ? undefined : argv[argv.indexOf(`--${name}`) + 1]);
  const opts = { runs: read('runs'), tables: read('tables'), date: read('date') };
  if (Object.values(opts).some((value) => !value)) throw new Error('usage: setup-compare.js --runs DIR --tables DIR --date YYYYMMDD');
  const analysis = Object.fromEntries(MODELS.map((model) => [model,
    JSON.parse(fs.readFileSync(path.join(opts.runs, model, 'analysis.json'), 'utf8'))]));
  const table = (model, name) => (analysis[model].tables[name] || []);

  const lines = [];
  const add = (measure, untuned, v7, unit = 'ms') => lines.push({ measure, unit, untuned, v7 });
  for (const group of ['mac-only', 'phone-only', 'combined', 'all']) {
    add(`end-to-end median, ${group}`, ...MODELS.map((model) => (table(model, 'steps_by_cell').find((l) => l.group === group) || {}).endToEndMedianMs));
  }
  add('model inference median (live)', ...MODELS.map((model) => (table(model, 'steps_by_cell').find((l) => l.group === 'all') || {}).inferenceMedianMs));
  add('reuse: first request median', ...MODELS.map((model) => (table(model, 'reuse').find((l) => l.group === 'all') || {}).firstRequestMedianMs));
  add('reuse: reused request median', ...MODELS.map((model) => (table(model, 'reuse').find((l) => l.group === 'all') || {}).reusedRequestMedianMs));
  add('reuse: requests exercised (of 12)', ...MODELS.map((model) => (table(model, 'reuse').find((l) => l.group === 'all') || {}).exercised), 'count');
  for (const setup of ['mac-only', 'phone-only', 'combined']) {
    add(`load: 25 at once, all decided after (mean of 2)`, ...MODELS.map((model) => (table(model, 'load').find((l) => l.setup === setup && l.level === 25) || {}).makespanMeanMs));
    lines[lines.length - 1].measure += `, ${setup}`;
  }
  for (const [name, unit] of [['decisionAccuracy', 'share of valid'], ['validAnswers', 'of 600'], ['falseAllow', 'count'], ['falseDeny', 'count'], ['macroF1', 'score']]) {
    add(`quality: ${name}`, ...MODELS.map((model) => (table(model, 'model_quality')[0] || {})[name]), unit);
  }

  const pairs = pairSteps(readRows(path.join(opts.runs, 'untuned', 'steps', 'rows.jsonl')),
    readRows(path.join(opts.runs, 'v7', 'steps', 'rows.jsonl')));
  // Milliseconds, except completionTokens.
  const paired = {
    inference: pairedDifference(pairs, (row) => row.modelInferenceMs),
    endToEnd: pairedDifference(pairs.filter(([a, b]) => a.status === 'completed' && b.status === 'completed'
      && a.followed && b.followed), (row) => row.endToEndMs),
    completionTokens: pairedDifference(pairs, (row) => row.completionTokens),
  };
  const agreement = adviceAgreement(pairs);

  fs.mkdirSync(opts.tables, { recursive: true });
  fs.writeFileSync(path.join(opts.tables, `${opts.date}_setups_models_compared.csv`), csv(lines));
  fs.writeFileSync(path.join(opts.runs, 'models-compared.json'), `${JSON.stringify({ lines, paired, agreement }, null, 1)}\n`);
  console.table(lines);
  console.log('paired, V7 minus untuned, same request:', JSON.stringify(paired, null, 1));
  console.log('advice on the same live requests:', JSON.stringify(agreement, null, 1));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { adviceAgreement, pairSteps, pairedDifference };
