'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  DECISION_SCHEMA,
  MODEL_VERSION,
  REASON_DECISION,
  REASON_CODES,
  RULES_SYSTEM_PROMPT,
  materializeDecision,
} = require('./policy_prompts');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TEST = path.join(__dirname, 'data_v3', 'test.jsonl');

function parseArgs(argv) {
  const args = {
    provider: 'ollama',
    url: 'http://localhost:11434',
    model: 'qwen3:14b',
    adapter: null,
    arm: 'no-rules',
    data: DEFAULT_TEST,
    output: null,
    limit: null,
    seed: 42,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (!(name in args)) throw new Error(`unknown option --${name}`);
    args[name] = argv[++i];
  }
  args.limit = args.limit === null ? null : Number(args.limit);
  args.seed = Number(args.seed);
  if (!['ollama', 'openai'].includes(args.provider)) {
    throw new Error('--provider must be ollama or openai');
  }
  if (!['no-rules', 'rules-prompt', 'subject-ablation'].includes(args.arm)) {
    throw new Error('--arm must be no-rules, rules-prompt, or subject-ablation');
  }
  if (!args.output) throw new Error('--output is required');
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function ablateSubject(content) {
  return content.replace(
    /(AUTHENTICATED SUBJECT:\n)([^\n]+)(\n\nLEDGER RESOURCE:)/,
    (_match, prefix, subjectJson, suffix) => {
      const subject = JSON.parse(subjectJson);
      const ablated = Object.fromEntries(Object.keys(subject).map((key) => [key, null]));
      return `${prefix}${JSON.stringify(ablated)}${suffix}`;
    });
}

function requestMessages(example, arm) {
  const [system, user] = example.messages;
  return [
    {
      role: 'system',
      content: arm === 'rules-prompt' ? RULES_SYSTEM_PROMPT : system.content,
    },
    {
      role: 'user',
      content: arm === 'subject-ablation' ? ablateSubject(user.content) : user.content,
    },
  ];
}

async function callOllama(args, messages) {
  const started = performance.now();
  const response = await fetch(`${args.url.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      messages,
      stream: false,
      think: false,
      format: DECISION_SCHEMA,
      options: {
        temperature: 0,
        top_p: 1,
        seed: args.seed,
        num_predict: 192,
      },
      keep_alive: '30m',
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${JSON.stringify(body)}`);
  return {
    text: String(body.message?.content || '').trim(),
    latencyMs: performance.now() - started,
    promptTokens: body.prompt_eval_count || null,
    completionTokens: body.eval_count || null,
    serverDurationNs: body.total_duration || null,
  };
}

async function callOpenAi(args, messages) {
  const started = performance.now();
  const response = await fetch(`${args.url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      messages,
      stream: false,
      temperature: 0,
      top_p: 1,
      seed: args.seed,
      max_tokens: 192,
      ...(args.adapter ? { adapters: args.adapter } : {}),
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`OpenAI-compatible server ${response.status}: ${JSON.stringify(body)}`);
  return {
    text: String(body.choices?.[0]?.message?.content || '').trim(),
    latencyMs: performance.now() - started,
    promptTokens: body.usage?.prompt_tokens || null,
    completionTokens: body.usage?.completion_tokens || null,
    serverDurationNs: null,
  };
}

function extractJson(text) {
  const trimmed = text.trim();
  try {
    return { value: JSON.parse(trimmed), strict: true };
  } catch {
    const withoutThinking = trimmed.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const start = withoutThinking.indexOf('{');
    const end = withoutThinking.lastIndexOf('}');
    if (start === -1 || end <= start) return { value: null, strict: false };
    try {
      return { value: JSON.parse(withoutThinking.slice(start, end + 1)), strict: false };
    } catch {
      return { value: null, strict: false };
    }
  }
}

function schemaProblems(value) {
  const problems = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['not an object'];
  const expectedKeys = [
    'action', 'decision', 'modelVersion', 'policyVersion', 'purpose', 'reasonCode',
  ];
  if (Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')) {
    problems.push('output does not contain exactly the compact decision fields');
  }
  if (!['view', 'export', 'annotate'].includes(value.action)) problems.push('invalid action');
  if (typeof value.purpose !== 'string' || !value.purpose) problems.push('invalid purpose');
  if (!['allow', 'deny', 'escalate'].includes(value.decision)) problems.push('invalid decision');
  if (!REASON_CODES.includes(value.reasonCode)) problems.push('invalid reasonCode');
  // Not a schema failure: the runtime derives the decision from the reason code.
  // Tracked separately by summarise() as decisionDisagreementRate.
  if (value.policyVersion !== 'crime-policy-v1') problems.push('invalid policyVersion');
  if (value.modelVersion !== MODEL_VERSION) problems.push('invalid modelVersion');
  return problems;
}

function equalSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return [...new Set(a)].sort().join('\u0000') === [...new Set(b)].sort().join('\u0000');
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

function f1(precision, recall) {
  if (precision === null || recall === null) return null;
  return precision + recall
    ? Number(((2 * precision * recall) / (precision + recall)).toFixed(4))
    : 0;
}

function macro(values) {
  const present = values.filter((value) => value !== null);
  return present.length
    ? Number((present.reduce((sum, value) => sum + value, 0) / present.length).toFixed(4))
    : null;
}

function summarise(rows) {
  const parsed = rows.filter((row) => row.prediction !== null);
  const schemaValid = rows.filter((row) => row.schemaProblems.length === 0);
  const expectedNonAllow = rows.filter((row) => row.expected.decision !== 'allow');
  const falseAllows = expectedNonAllow.filter((row) => row.prediction?.decision === 'allow');
  const latencies = rows.filter((row) => row.latencyMs !== null).map((row) => row.latencyMs);
  const perDecision = {};
  for (const decision of ['allow', 'deny', 'escalate']) {
    const subset = rows.filter((row) => row.expected.decision === decision);
    const predicted = rows.filter((row) => row.prediction?.decision === decision);
    const truePositives = subset.filter((row) => row.prediction?.decision === decision).length;
    const precision = predicted.length ? ratio(truePositives, predicted.length) : 0;
    const recall = ratio(truePositives, subset.length);
    perDecision[decision] = {
      support: subset.length,
      precision,
      recall,
      f1: f1(precision, recall),
    };
  }
  const perReason = {};
  for (const reason of REASON_CODES) {
    const subset = rows.filter((row) => row.expected.reasonCode === reason);
    if (subset.length) {
      const predicted = rows.filter((row) => row.prediction?.reasonCode === reason);
      const truePositives = subset.filter((row) => row.prediction?.reasonCode === reason).length;
      const precision = predicted.length ? ratio(truePositives, predicted.length) : 0;
      const recall = ratio(truePositives, subset.length);
      perReason[reason] = {
        support: subset.length,
        precision,
        recall,
        f1: f1(precision, recall),
      };
    }
  }
  return {
    n: rows.length,
    parseRate: ratio(parsed.length, rows.length),
    decisionDisagreementRate: ratio(rows.filter((row) => row.decisionDisagreement).length, rows.length),
    strictJsonRate: ratio(rows.filter((row) => row.strictJson).length, rows.length),
    schemaValidRate: ratio(schemaValid.length, rows.length),
    decisionAccuracy: ratio(rows.filter((row) => row.decisionCorrect).length, rows.length),
    decisionMacroF1: macro(Object.values(perDecision).map((item) => item.f1)),
    reasonAccuracy: ratio(rows.filter((row) => row.reasonCorrect).length, rows.length),
    reasonMacroF1: macro(Object.values(perReason).map((item) => item.f1)),
    jointDecisionReasonAccuracy: ratio(rows.filter((row) => row.jointCorrect).length, rows.length),
    decisiveAttributeExactRate: ratio(rows.filter((row) => row.attributesCorrect).length, rows.length),
    parsedActionAccuracy: ratio(rows.filter((row) => row.actionCorrect).length, rows.length),
    parsedPurposeAccuracy: ratio(rows.filter((row) => row.purposeCorrect).length, rows.length),
    falseAllowRateAmongNonAllow: ratio(falseAllows.length, expectedNonAllow.length),
    falseAllowCount: falseAllows.length,
    expectedNonAllowCount: expectedNonAllow.length,
    adversarialJointAccuracy: ratio(
      rows.filter((row) => row.adversarial && row.jointCorrect).length,
      rows.filter((row) => row.adversarial).length),
    latencyMs: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      mean: latencies.length
        ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2))
        : null,
    },
    perDecision,
    perReason,
  };
}

async function getOllamaModelInfo(args) {
  if (args.provider !== 'ollama') return null;
  const baseUrl = args.url.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: args.model, verbose: false }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const [tagsResponse, versionResponse] = await Promise.all([
    fetch(`${baseUrl}/api/tags`),
    fetch(`${baseUrl}/api/version`),
  ]);
  const tags = tagsResponse.ok ? await tagsResponse.json() : { models: [] };
  const version = versionResponse.ok ? await versionResponse.json() : null;
  const installed = tags.models?.find(
    (candidate) => candidate.name === args.model || candidate.model === args.model
  );
  return {
    digest: installed?.digest || null,
    ollamaVersion: version?.version || null,
    details: body.details,
    parameters: body.parameters,
    modelInfo: body.model_info ? {
      architecture: body.model_info['general.architecture'],
      parameterCount: body.model_info['general.parameter_count'],
      contextLength: body.model_info['qwen3.context_length'],
    } : null,
  };
}

function getMlxModelInfo(args) {
  if (args.provider !== 'openai') return null;
  let adapterSha256 = null;
  let adapterFile = null;
  if (args.adapter) {
    const candidate = path.resolve(args.adapter);
    adapterFile = fs.statSync(candidate).isDirectory()
      ? path.join(candidate, 'adapters.safetensors') : candidate;
    adapterSha256 = sha256(fs.readFileSync(adapterFile));
  }
  const cacheName = `models--${args.model.replace('/', '--')}`;
  const reference = path.join(
    process.env.HOME || '', '.cache', 'huggingface', 'hub', cacheName, 'refs', 'main'
  );
  return {
    baseModel: args.model,
    baseModelRevision: fs.existsSync(reference) ? fs.readFileSync(reference, 'utf8').trim() : null,
    adapterFile: adapterFile ? path.relative(ROOT, adapterFile) : null,
    adapterSha256,
    serving: {
      engine: 'mlx_lm.server', temperature: 0, topP: 1,
      maxTokens: 192, enableThinking: false,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const allExamples = readJsonl(path.resolve(args.data));
  const examples = args.limit === null ? allExamples : allExamples.slice(0, args.limit);
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = [];
  const call = args.provider === 'ollama' ? callOllama : callOpenAi;

  for (let index = 0; index < examples.length; index += 1) {
    const example = examples[index];
    const expected = example.metadata.oracleOutput;
    let response;
    let error = null;
    try {
      response = await call(args, requestMessages(example, args.arm));
    } catch (firstError) {
      try {
        response = await call(args, requestMessages(example, args.arm));
      } catch (secondError) {
        error = `${firstError.message}; retry: ${secondError.message}`;
        response = { text: '', latencyMs: null, promptTokens: null, completionTokens: null };
      }
    }
    const extracted = extractJson(response.text);
    const classification = extracted.value;
    const problems = schemaProblems(classification);
    let prediction = null;
    if (problems.length === 0) {
      try {
        prediction = materializeDecision(classification, example.metadata.trusted);
      } catch (materializeError) {
        problems.push(`materialization failed: ${materializeError.message}`);
      }
    }
    const row = {
      id: example.metadata.id,
      adversarial: example.metadata.adversarial,
      expected,
      prediction,
      classification,
      raw: response.text,
      strictJson: extracted.strict,
      // Did the model's own decision field contradict the reason code it chose?
      // Not an error (the runtime derives the decision) but a model-quality signal.
      decisionDisagreement: Boolean(classification
        && REASON_DECISION[classification.reasonCode]
        && REASON_DECISION[classification.reasonCode] !== classification.decision),
      schemaProblems: problems,
      decisionCorrect: prediction?.decision === expected.decision,
      reasonCorrect: prediction?.reasonCode === expected.reasonCode,
      jointCorrect: prediction?.decision === expected.decision
        && prediction?.reasonCode === expected.reasonCode,
      attributesCorrect: equalSet(prediction?.decisiveAttributes, expected.decisiveAttributes),
      actionCorrect: prediction?.parsedRequest?.action === expected.parsedRequest.action,
      purposeCorrect: prediction?.parsedRequest?.purpose === expected.parsedRequest.purpose,
      latencyMs: response.latencyMs === null ? null : Number(response.latencyMs.toFixed(2)),
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      error,
    };
    rows.push(row);
    process.stdout.write(
      `${index + 1}/${examples.length} ${row.id} `
      + `expected=${expected.decision}/${expected.reasonCode} `
      + `predicted=${prediction?.decision || 'PARSE_ERROR'}/${prediction?.reasonCode || '-'}\n`);
  }

  const report = {
    createdAtUtc: new Date().toISOString(),
    config: {
      ...args,
      data: path.relative(ROOT, path.resolve(args.data)),
      output: path.relative(ROOT, outputPath),
      testDataSha256: sha256(fs.readFileSync(path.resolve(args.data))),
    },
    modelInfo: args.provider === 'ollama'
      ? await getOllamaModelInfo(args) : getMlxModelInfo(args),
    metrics: summarise(rows),
    rows,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.metrics, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { summarise, extractJson, schemaProblems, ablateSubject };
