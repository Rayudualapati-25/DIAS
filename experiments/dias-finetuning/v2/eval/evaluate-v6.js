#!/usr/bin/env node
'use strict';

/**
 * Evaluate the retained V6 adapter on the DIAS v2 held-out sets.
 *
 * V6 is a historical reference. The adaptations required to ask it these
 * questions at all are recorded in the output, and the report must present the
 * comparison as a reference point rather than a fair head-to-head — V6 is not
 * shown the action or the purpose, which V7 receives as verified facts.
 *
 *   node experiments/dias-finetuning/v2/eval/evaluate-v6.js \
 *     --url http://127.0.0.1:8080/v1 --out experiments/runs/<date>_dias_v6_reference
 */

const fs = require('fs');
const path = require('path');

const { ADAPTATIONS, parseV6, v6Messages } = require('./v6-adapter');
const { errorCategories, groupBy, summarize } = require('./metrics');
const { readCases } = require('./runner');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const DEFAULT_SETS = ['test-decision-balanced', 'test-adversarial', 'test-multi-rule'];

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

async function ask({ url, servedModel, messages, maxTokens, timeoutMs }) {
  const started = performance.now();
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: servedModel, messages, stream: false,
        temperature: 0, top_p: 1, max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const latencyMs = Number((performance.now() - started).toFixed(1));
    if (!response.ok) return { content: null, latencyMs };
    const body = JSON.parse(text);
    return { content: body.choices?.[0]?.message?.content ?? null, latencyMs };
  } catch {
    return { content: null, latencyMs: Number((performance.now() - started).toFixed(1)) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || 'http://127.0.0.1:8080/v1';
  const servedModel = args['served-model'] || 'default_model';
  const maxTokens = Number(args['max-tokens'] || 192);
  const timeoutMs = Number(args.timeout || 120000);
  const sets = args.sets ? String(args.sets).split(',') : [...DEFAULT_SETS];
  const outDir = path.resolve(args.out || 'experiments/runs/dias-v6-reference');

  fs.mkdirSync(path.join(outDir, 'predictions'), { recursive: true });
  const metrics = {};
  for (const name of sets) {
    let cases = readCases(DATASET, name);
    if (args.limit) cases = cases.slice(0, Number(args.limit));
    const file = path.join(outDir, 'predictions', `${name}.jsonl`);
    let results = [];
    if (args['skip-existing'] && fs.existsSync(file)) {
      results = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      if (results.length !== cases.length) results = [];
    }
    if (results.length === 0) {
      process.stdout.write(`[v6] ${name} (${cases.length} examples)\n`);
      for (let i = 0; i < cases.length; i += 1) {
        const example = cases[i];
        const reply = await ask({ url, servedModel, messages: v6Messages(example), maxTokens, timeoutMs });
        const parsed = reply.content === null
          ? { recommendation: null, status: 'UNAVAILABLE', sealDecision: null }
          : parseV6(reply.content);
        results.push({
          exampleId: example.exampleId,
          scenario: example.scenario,
          justificationKind: example.justificationKind,
          role: example.verifiedRequest.requester.role,
          organization: example.verifiedRequest.requester.organization,
          expected: example.label,
          predicted: parsed.recommendation,
          status: parsed.status,
          sealDecision: parsed.sealDecision,
          sealReasonCode: parsed.sealReasonCode ?? null,
          // V6 has to infer these; V7 is told them. Recorded so the report can
          // separate "misread the request" from "misapplied the policy".
          inferredAction: parsed.inferredAction ?? null,
          inferredPurpose: parsed.inferredPurpose ?? null,
          trueAction: example.verifiedRequest.request.action,
          truePurpose: example.verifiedRequest.request.purpose,
          latencyMs: reply.latencyMs,
        });
        if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${cases.length}\r`);
      }
      fs.writeFileSync(file, `${results.map((r) => JSON.stringify(r)).join('\n')}\n`);
    }
    const summary = summarize(results);
    const escalated = results.filter((r) => r.status === 'ESCALATE_NOT_IN_BINARY_CONTRACT').length;
    const misreadAction = results.filter(
      (r) => r.inferredAction !== null && r.inferredAction !== r.trueAction).length;
    const misreadPurpose = results.filter(
      (r) => r.inferredPurpose !== null && r.inferredPurpose !== r.truePurpose).length;
    metrics[name] = {
      ...summary,
      escalateCount: escalated,
      escalateRate: Number((escalated / results.length).toFixed(6)),
      requestMisreading: {
        actionMisread: misreadAction,
        purposeMisread: misreadPurpose,
        note: 'V6 infers action and purpose from the request text because the SEAL '
          + 'prompt withheld them. A misreading here is a prompt-contract difference, '
          + 'not a policy error.',
      },
      errorCategories: errorCategories(results),
      byJustificationKind: groupBy(results, (r) => r.justificationKind),
    };
    process.stdout.write(
      `  valid ${summary.schemaValid}/${summary.examples}  accuracy ${summary.decisionAccuracy ?? 'n/a'}`
      + `  macroF1 ${summary.macroF1 ?? 'n/a'}  falseALLOW ${summary.falseAllow.count}`
      + `  escalate ${escalated}  misread action/purpose ${misreadAction}/${misreadPurpose}\n`);
  }

  fs.writeFileSync(path.join(outDir, 'metrics.json'), `${JSON.stringify({
    artifactType: 'dias-v6-reference-evaluation',
    label: 'v6-seba-lora (historical reference)',
    evaluatedAtUtc: new Date().toISOString(),
    model: { url, servedModel, adapter: 'qwen3-14b-seba-lora-v6-best' },
    decoding: { temperature: 0, topP: 1, maxTokens },
    schemaAdaptations: ADAPTATIONS,
    comparability: 'REFERENCE ONLY. V6 was trained on a different contract and is '
      + 'not shown the action or purpose, which V7 receives as verified facts. Its '
      + 'numbers bound what the SEAL-era model does on this task; they are not a '
      + 'fair head-to-head against a model built for it.',
    sets: metrics,
  }, null, 2)}\n`);
  console.log(`\nwritten to ${outDir}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[v6] ${error.stack || error.message}`);
    process.exit(1);
  });
}
