#!/usr/bin/env node
'use strict';

/**
 * Stage one training directory for MLX-LM.
 *
 * MLX-LM takes a DIRECTORY and expects `train.jsonl` and `valid.jsonl` inside
 * it. A subset is therefore not usable directly — it has to be staged next to
 * the validation set it will be selected on.
 *
 * The validation set is the SAME file for every subset, deliberately: a learning
 * curve whose validation set also changed would measure two things at once.
 *
 *   node experiments/dias-finetuning/v2/stage-training-dir.js --size 1600
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATASET = path.resolve(__dirname, '..', 'data-v2-binary');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function main() {
  const args = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const size = args.size ? Number(args.size) : null;
  const outDir = path.resolve(args.out
    || path.join(DATASET, 'staged', size === null ? 'full' : `train-${size}`));

  const trainSource = size === null
    ? path.join(DATASET, 'train.jsonl')
    : path.join(DATASET, 'subsets', `train-${size}.jsonl`);
  const validSource = path.join(DATASET, 'valid.jsonl');
  const testSource = path.join(DATASET, 'test.jsonl');
  for (const file of [trainSource, validSource, testSource]) {
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(trainSource, path.join(outDir, 'train.jsonl'));
  fs.copyFileSync(validSource, path.join(outDir, 'valid.jsonl'));
  fs.copyFileSync(testSource, path.join(outDir, 'test.jsonl'));

  const lines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  const record = {
    artifactType: 'dias-v2-staged-training-directory',
    stagedAtUtc: new Date().toISOString(),
    trainingCount: lines(path.join(outDir, 'train.jsonl')),
    validationCount: lines(path.join(outDir, 'valid.jsonl')),
    testCount: lines(path.join(outDir, 'test.jsonl')),
    sources: {
      train: path.relative(process.cwd(), trainSource),
      valid: path.relative(process.cwd(), validSource),
      test: path.relative(process.cwd(), testSource),
    },
    sha256: {
      train: sha256(path.join(outDir, 'train.jsonl')),
      valid: sha256(path.join(outDir, 'valid.jsonl')),
      test: sha256(path.join(outDir, 'test.jsonl')),
    },
    note: 'valid.jsonl is identical across every staged directory, so a learning '
      + 'curve varies the training count alone. test.jsonl is present because '
      + 'MLX-LM expects it; it is NOT read during training or selection.',
  };
  fs.writeFileSync(path.join(outDir, 'staging.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${outDir}\n  train ${record.trainingCount}  valid ${record.validationCount}`
    + `  test ${record.testCount}\n  train sha256 ${record.sha256.train}`);
  console.log(`  iters for one pass: ${record.trainingCount}`);
}

if (require.main === module) main();
