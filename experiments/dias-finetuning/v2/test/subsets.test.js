'use strict';

/**
 * Training-subset properties.
 *
 * A subset is only useful for a learning curve if it is nested — otherwise two
 * points on the curve differ by sampling as well as by size, and the curve
 * measures nothing. It is only useful at all if it still covers the task.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SUBSETS = path.resolve(__dirname, '..', '..', 'data-v2-binary', 'subsets');
const TRAIN = path.resolve(__dirname, '..', '..', 'data-v2-binary', 'train.cases.jsonl');

const read = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const manifest = JSON.parse(fs.readFileSync(path.join(SUBSETS, 'manifest.json'), 'utf8'));
const sizes = Object.keys(manifest.subsets).map(Number).sort((a, b) => a - b);
const subsets = new Map(sizes.map((size) => [size, read(path.join(SUBSETS, `train-${size}.cases.jsonl`))]));
const pool = read(TRAIN);

test('each subset has the size it claims', () => {
  for (const size of sizes) {
    assert.equal(subsets.get(size).length, size);
    assert.equal(manifest.subsets[size].examples, size);
  }
});

test('subsets are nested, so a learning curve measures added data', () => {
  for (let i = 1; i < sizes.length; i += 1) {
    const smaller = new Set(subsets.get(sizes[i - 1]).map((e) => e.exampleId));
    const larger = new Set(subsets.get(sizes[i]).map((e) => e.exampleId));
    const missing = [...smaller].filter((id) => !larger.has(id));
    assert.deepEqual(missing, [],
      `${sizes[i - 1]} is not contained in ${sizes[i]}; the curve would confound size with sampling`);
    assert.equal(manifest.subsets[sizes[i]].nestedInsidePrevious, true);
  }
});

test('every subset is drawn only from the training pool', () => {
  const trainIds = new Set(pool.map((e) => e.exampleId));
  for (const size of sizes) {
    const outside = subsets.get(size).filter((e) => !trainIds.has(e.exampleId));
    assert.deepEqual(outside, [], `${size} contains examples that are not in train`);
  }
});

test('no subset contains a duplicate', () => {
  for (const size of sizes) {
    const ids = subsets.get(size).map((e) => e.exampleId);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('every subset stays balanced', () => {
  for (const size of sizes) {
    const allow = subsets.get(size).filter((e) => e.label.recommendation === 'ALLOW').length;
    const share = allow / size;
    assert.ok(Math.abs(share - 0.5) <= 0.03,
      `${size} has ALLOW share ${share.toFixed(3)}`);
  }
});

test('every subset still covers every reason code and scenario in the pool', () => {
  // A subset that silently drops SEALED_RECORD is not a smaller version of the
  // task; it is a different task, and its learning curve would be misleading.
  const poolCodes = new Set(pool.map((e) => e.label.reason_code));
  const poolScenarios = new Set(pool.map((e) => e.scenario.split(':')[0]));
  for (const size of sizes) {
    const codes = new Set(subsets.get(size).map((e) => e.label.reason_code));
    const scenarios = new Set(subsets.get(size).map((e) => e.scenario.split(':')[0]));
    assert.deepEqual([...poolCodes].filter((c) => !codes.has(c)), [],
      `${size} lost a reason code`);
    assert.deepEqual([...poolScenarios].filter((s) => !scenarios.has(s)), [],
      `${size} lost a scenario`);
  }
});

test('every subset keeps adversarial text, which is a minority and easy to lose', () => {
  for (const size of sizes) {
    const kinds = new Set(subsets.get(size).map((e) => e.justificationKind));
    for (const kind of ['plain', 'contradictory', 'injection']) {
      assert.ok(kinds.has(kind), `${size} has no ${kind} justification`);
    }
  }
});

test('the training lines match their audit records, line for line', () => {
  for (const size of sizes) {
    const lines = fs.readFileSync(path.join(SUBSETS, `train-${size}.jsonl`), 'utf8')
      .split('\n').filter(Boolean);
    const cases = subsets.get(size);
    assert.equal(lines.length, cases.length);
    for (let i = 0; i < lines.length; i += 1) {
      const completion = JSON.parse(lines[i]).messages.at(-1);
      assert.equal(completion.role, 'assistant');
      assert.deepEqual(JSON.parse(completion.content), cases[i].label,
        `${size} line ${i + 1} completion does not match its recorded label`);
    }
  }
});

test('the manifest records a hash for every subset file', () => {
  const crypto = require('crypto');
  for (const size of sizes) {
    const actual = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(SUBSETS, `train-${size}.jsonl`))).digest('hex');
    assert.equal(manifest.subsets[size].sha256, actual, `${size} hash is stale`);
  }
});
