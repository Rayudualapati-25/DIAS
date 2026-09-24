#!/usr/bin/env node
'use strict';

/**
 * Evaluate one served model over the DIAS v2 held-out sets.
 *
 *   node experiments/dias-finetuning/v2/eval/evaluate.js \
 *     --label untuned-qwen3-14b-4bit \
 *     --url http://127.0.0.1:8081/v1 \
 *     --out experiments/runs/20260912_dias_qwen3_baseline
 *
 * Raw predictions are written per set so any metric can be recomputed without
 * rerunning inference, which is the expensive part.
 */

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_SETS, createEvaluationRecommender, evaluateSet, readCases, runDescriptor,
} = require('./runner');
const { errorCategories, groupBy, summarize } = require('./metrics');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const BASE_IDENTITY = Object.freeze({
  modelId: 'qwen3-14b-4bit-untuned',
  modelFamily: 'qwen3',
  baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4',
  quantization: '4bit',
  adapterId: null,
  adapterHash: null,
});

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith('--') ? true : (i += 1, next);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || 'unnamed-model';
  const outDir = path.resolve(args.out || path.join('experiments', 'runs', `eval-${label}`));
  const datasetDir = args.dataset ? path.resolve(args.dataset) : DATASET;
  const sets = args.sets ? String(args.sets).split(',') : [...DEFAULT_SETS];
  const limit = args.limit ? Number(args.limit) : null;
  const maxTokens = Number(args['max-tokens'] || 512);

  const modelIdentity = {
    ...BASE_IDENTITY,
    ...(args['model-id'] ? { modelId: args['model-id'] } : {}),
    ...(args['adapter-id'] ? { adapterId: args['adapter-id'] } : {}),
    ...(args['adapter-hash'] ? { adapterHash: args['adapter-hash'] } : {}),
  };
  const recommender = createEvaluationRecommender({
    url: args.url || 'http://127.0.0.1:8081/v1',
    servedModel: args['served-model'] || 'default_model',
    adapterPath: args['adapter-path'] || null,
    modelIdentity,
    maxTokens,
    timeoutMs: Number(args.timeout || 180000),
  });

  fs.mkdirSync(path.join(outDir, 'predictions'), { recursive: true });
  const descriptor = runDescriptor({
    label,
    modelIdentity,
    url: args.url || 'http://127.0.0.1:8081/v1',
    servedModel: args['served-model'] || 'default_model',
    adapterPath: args['adapter-path'] || null,
    maxTokens,
    datasetDir,
  });

  const metrics = {};
  const started = Date.now();
  for (const name of sets) {
    let cases = readCases(datasetDir, name);
    if (limit) cases = cases.slice(0, limit);
    const predictionsFile = path.join(outDir, 'predictions', `${name}.jsonl`);
    let results;
    // A six-hour evaluation must not restart from zero after an interruption.
    // Completed predictions are reused; a partial file is discarded rather than
    // mixed with a later run, because the two halves would come from different
    // server states.
    if (args['skip-existing'] && fs.existsSync(predictionsFile)) {
      const existing = fs.readFileSync(predictionsFile, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line));
      if (existing.length === cases.length) {
        process.stdout.write(`[eval] ${label} :: ${name} reusing ${existing.length} predictions\n`);
        results = existing;
      }
    }
    if (!results) {
      process.stdout.write(`[eval] ${label} :: ${name} (${cases.length} examples)\n`);
      results = await evaluateSet({
        recommender,
        cases,
        onProgress: (done, total) => process.stdout.write(`  ${done}/${total}\r`),
      });
      fs.writeFileSync(predictionsFile, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
    const summary = summarize(results);
    metrics[name] = {
      ...summary,
      errorCategories: errorCategories(results),
      byScenario: groupBy(results, (r) => r.scenario.split(':')[0]),
      byJustificationKind: groupBy(results, (r) => r.justificationKind),
      byRole: groupBy(results, (r) => r.role),
      byOrganization: groupBy(results, (r) => r.organization),
    };
    process.stdout.write(
      `  valid ${summary.schemaValid}/${summary.examples}`
      + `  accuracy ${summary.decisionAccuracy ?? 'n/a'}`
      + `  macroF1 ${summary.macroF1 ?? 'n/a'}`
      + `  falseALLOW ${summary.falseAllow.count}`
      + `  falseDENY ${summary.falseDeny.count}`
      + `  p95 ${summary.latencyMs.p95} ms\n`);
  }

  const report = {
    ...descriptor,
    durationSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    sets: metrics,
  };
  fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwritten to ${outDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[eval] ${error.stack || error.message}`);
    process.exit(1);
  });
}
