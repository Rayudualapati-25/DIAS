#!/usr/bin/env node
'use strict';

/**
 * Run the prompt ablations for one served model.
 *
 * Every ablation sees the same examples in the same order with the same
 * decoding, and differs from the control only inside the redacted region, so a
 * difference in accuracy is attributable to the component removed.
 *
 *   node experiments/dias-finetuning/v2/eval/run-ablations.js \
 *     --label untuned-qwen3-14b-4bit --url http://127.0.0.1:8081/v1 \
 *     --limit 120 --out experiments/runs/<date>_dias_ablations
 */

const fs = require('fs');
const path = require('path');

const { createPolicyContextProvider } = require('../../../../backend/src/dias/policyContextProvider');
const { parseRecommendation } = require('../../../../backend/src/dias/recommendationContract');
const { loadBundle } = require('../../../../policies/lib/bundle');
const { ABLATIONS, ABLATION_NAMES, ablatedMessages } = require('./ablations');
const { errorCategories, summarize } = require('./metrics');
const { readCases } = require('./runner');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const DEFAULT_SET = 'test-decision-balanced';

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

/**
 * Call the model directly rather than through the recommender: an ablated prompt
 * is not one the recommender would ever build, and routing it through the live
 * path would misrepresent what that path does.
 */
async function ask({ url, servedModel, adapterPath, messages, maxTokens, timeoutMs }) {
  const started = performance.now();
  const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: servedModel, messages, stream: false,
      temperature: 0, top_p: 1, max_tokens: maxTokens,
      ...(adapterPath ? { adapters: adapterPath } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const latencyMs = Number((performance.now() - started).toFixed(1));
  if (!response.ok) return { content: null, latencyMs, httpStatus: response.status };
  try {
    const body = JSON.parse(text);
    return { content: body.choices?.[0]?.message?.content ?? null, latencyMs, httpStatus: 200 };
  } catch {
    return { content: null, latencyMs, httpStatus: 200 };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || 'unnamed-model';
  const url = args.url || 'http://127.0.0.1:8081/v1';
  const servedModel = args['served-model'] || 'default_model';
  const adapterPath = args['adapter-path'] || null;
  const maxTokens = Number(args['max-tokens'] || 512);
  const timeoutMs = Number(args.timeout || 240000);
  const setName = args.set || DEFAULT_SET;
  const outDir = path.resolve(args.out || `experiments/runs/ablations-${label}`);
  const names = args.only ? String(args.only).split(',') : [...ABLATION_NAMES];

  const { bundle, clauseRefs } = loadBundle();
  const policy = {
    clauseRefs, reasonCodes: bundle.reasonCodes, reviewFlags: Object.keys(bundle.reviewFlags),
  };
  const provider = createPolicyContextProvider({});
  let cases = readCases(DATASET, setName);
  if (args.limit) cases = cases.slice(0, Number(args.limit));

  fs.mkdirSync(path.join(outDir, 'predictions'), { recursive: true });
  const metrics = {};
  for (const name of names) {
    const file = path.join(outDir, 'predictions', `${name}.jsonl`);
    let results = [];
    if (args['skip-existing'] && fs.existsSync(file)) {
      results = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (results.length !== cases.length) results = [];
    }
    if (results.length === 0) {
      process.stdout.write(`[ablate] ${label} :: ${name} (${cases.length} examples)\n`);
      for (let i = 0; i < cases.length; i += 1) {
        const example = cases[i];
        const messages = ablatedMessages(name, {
          verifiedRequest: example.verifiedRequest,
          policyContext: provider.assemble(example.verifiedRequest),
          justification: example.justification,
        });
        const reply = await ask({
          url, servedModel, adapterPath, messages, maxTokens, timeoutMs,
        });
        const parsed = reply.content === null
          ? { status: 'UNAVAILABLE', recommendation: null, errors: ['no content'] }
          : parseRecommendation(reply.content, policy);
        results.push({
          exampleId: example.exampleId,
          scenario: example.scenario,
          justificationKind: example.justificationKind,
          role: example.verifiedRequest.requester.role,
          organization: example.verifiedRequest.requester.organization,
          expected: example.label,
          predicted: parsed.recommendation,
          status: parsed.status,
          parserErrors: parsed.errors || [],
          latencyMs: reply.latencyMs,
        });
        if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${cases.length}\r`);
      }
      fs.writeFileSync(file, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
    const summary = summarize(results);
    metrics[name] = {
      ...summary,
      ablation: { label: ABLATIONS[name].label, expectation: ABLATIONS[name].expectation },
      errorCategories: errorCategories(results),
    };
    process.stdout.write(
      `  ${name.padEnd(20)} valid ${summary.schemaValid}/${summary.examples}`
      + `  accuracy ${summary.decisionAccuracy ?? 'n/a'}`
      + `  macroF1 ${summary.macroF1 ?? 'n/a'}`
      + `  falseALLOW ${summary.falseAllow.count}\n`);
  }

  // Deltas against the control, so the table reads as "what removing this cost".
  const control = metrics.full;
  const deltas = control ? Object.fromEntries(Object.entries(metrics).map(([name, m]) => [name, {
    decisionAccuracyDelta: m.decisionAccuracy === null || control.decisionAccuracy === null
      ? null : Number((m.decisionAccuracy - control.decisionAccuracy).toFixed(6)),
    macroF1Delta: m.macroF1 === null || control.macroF1 === null
      ? null : Number((m.macroF1 - control.macroF1).toFixed(6)),
    falseAllowDelta: m.falseAllow.count - control.falseAllow.count,
    schemaValidDelta: Number((m.schemaValidRate - control.schemaValidRate).toFixed(6)),
  }])) : null;

  fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify({
    artifactType: 'dias-prompt-ablations',
    label,
    model: { url, servedModel, adapterPath },
    evaluatedAtUtc: new Date().toISOString(),
    set: setName,
    examples: cases.length,
    decoding: { temperature: 0, topP: 1, maxTokens },
    ablations: metrics,
    deltasVersusControl: deltas,
    note: 'Prompt (input) ablations on a trained model. Training-data ablations '
      + 'require separate runs and are not included here.',
  }, null, 2)}\n`);
  console.log(`\nwritten to ${outDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[ablate] ${error.stack || error.message}`);
    process.exit(1);
  });
}
