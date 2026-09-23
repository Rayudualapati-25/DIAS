'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { generateDataset, RECOMMENDATION_REASONS } = require('./generate');
const { validateDataset } = require('./validate');

test('small deterministic dataset covers every reason and validates', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-dataset-'));
  const perReason = { train: 4, valid: 2, test: 2 };
  const manifest = generateDataset({ dataDir, outputDir: dataDir, perReason, seed: 7 });
  assert.equal(manifest.splits.train.examples, RECOMMENDATION_REASONS.length * 4);
  assert.equal(manifest.workflowEvaluationSequences, 9);
  const report = validateDataset(dataDir, { perReason });
  assert.equal(report.valid, true);
  assert.equal(report.oneFieldNearMissDimensions, 21);
});

test('same seed produces byte-identical dataset artifacts', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-data-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-data-b-'));
  const options = { perReason: { train: 2, valid: 1, test: 1 }, seed: 91 };
  const left = generateDataset({ ...options, outputDir: first });
  const right = generateDataset({ ...options, outputDir: second });
  assert.deepEqual(left.artifacts, right.artifacts);
});
