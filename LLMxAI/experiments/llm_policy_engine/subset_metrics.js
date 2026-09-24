'use strict';

// Derive metrics for a fixed subset suite (e.g. test_balanced_60.jsonl) from an
// evaluation run over its superset, without re-running inference. The subset rows
// are byte-identical model outputs; only the population changes.
//
//   node subset_metrics.js <run.json> <subset.jsonl> <output.json>

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { summarise } = require('./evaluate');

const ROOT = path.resolve(__dirname, '..', '..');
const [, , runPath, subsetPath, outputPath] = process.argv;
if (!runPath || !subsetPath || !outputPath) {
  throw new Error('usage: subset_metrics.js <run.json> <subset.jsonl> <output.json>');
}

const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
const subsetBytes = fs.readFileSync(subsetPath);
const ids = new Set(subsetBytes.toString('utf8').trim().split('\n').filter(Boolean)
  .map((line) => JSON.parse(line).metadata.id));
const rows = run.rows.filter((row) => ids.has(row.id));
if (rows.length !== ids.size) {
  throw new Error(`subset has ${ids.size} ids but only ${rows.length} were found in the run`);
}
const report = {
  ...run,
  createdAtUtc: new Date().toISOString(),
  derivedFrom: path.relative(ROOT, path.resolve(runPath)),
  config: {
    ...run.config,
    data: path.relative(ROOT, path.resolve(subsetPath)),
    output: path.relative(ROOT, path.resolve(outputPath)),
    testDataSha256: crypto.createHash('sha256').update(subsetBytes).digest('hex'),
  },
  metrics: summarise(rows),
  rows,
};
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report.metrics, null, 2)}\n`);
