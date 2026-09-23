'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  MODEL_VERSION,
  SYSTEM_PROMPT,
  buildUserPrompt,
  explainClassification,
  parseStrictJson,
} = require('./policy');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ADAPTER_PATH = path.join(
  PROJECT_ROOT,
  'experiments',
  'llm_policy_engine',
  'adapters',
  'qwen3-14b-seba-lora-v4-best'
);
const DEFAULT_ADAPTER_HASH = 'bdb012513c123311821a8f2a7c10c290dd6dfa52dd51632954484aac2efc873b';

function config(overrides = {}) {
  return {
    url: String(overrides.url || process.env.LLM_POLICY_URL || 'http://127.0.0.1:8080/v1').replace(/\/$/, ''),
    servedModel: overrides.servedModel || process.env.LLM_POLICY_MODEL || 'mlx-community/Qwen3-14B-4bit',
    adapterPath: path.resolve(overrides.adapterPath || process.env.LLM_POLICY_ADAPTER_PATH || DEFAULT_ADAPTER_PATH),
    adapterHash: overrides.adapterHash || process.env.LLM_POLICY_ADAPTER_HASH || DEFAULT_ADAPTER_HASH,
    timeoutMs: Number(overrides.timeoutMs || process.env.LLM_POLICY_TIMEOUT_MS || 60000),
  };
}

function adapterArtifact(adapterPath) {
  const stat = fs.statSync(adapterPath);
  return stat.isDirectory() ? path.join(adapterPath, 'adapters.safetensors') : adapterPath;
}

function verifyAdapter(settings = config()) {
  if (!/^[0-9a-f]{64}$/.test(settings.adapterHash)) {
    throw new Error('The configured adapter hash is not a SHA-256 digest.');
  }
  let artifact;
  try {
    artifact = adapterArtifact(settings.adapterPath);
  } catch (_error) {
    throw new Error(`The selected adapter is unavailable at ${settings.adapterPath}.`);
  }
  if (!fs.statSync(artifact).isFile()) throw new Error('The selected adapter artifact is not a file.');
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  if (actualHash !== settings.adapterHash) {
    throw new Error('The selected adapter bytes do not match the retained V4 digest.');
  }
  return { artifact, actualHash };
}

function messagesFor(input) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildUserPrompt({
        query: input.query,
        subject: input.subject,
        record: input.record,
        requestContext: input.requestContext,
      }),
    },
  ];
}

async function decide(input, overrides = {}) {
  const settings = config(overrides);
  const fetchImpl = overrides.fetchImpl || fetch;
  const verified = overrides.skipAdapterVerification
    ? { artifact: settings.adapterPath, actualHash: settings.adapterHash }
    : verifyAdapter(settings);
  const messages = messagesFor(input);
  const started = performance.now();
  const response = await fetchImpl(`${settings.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.servedModel,
      messages,
      stream: false,
      temperature: 0,
      top_p: 1,
      seed: 42,
      max_tokens: 192,
      adapters: settings.adapterPath,
    }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`The Qwen service returned HTTP ${response.status}.`);
  }
  const raw = String(body.choices?.[0]?.message?.content || '').trim();
  const classification = parseStrictJson(raw);
  const result = explainClassification(classification, input);
  return {
    result,
    evidence: {
      adapterSha256: verified.actualHash,
      latencyMs: Number((performance.now() - started).toFixed(2)),
      promptSha256: crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      rawOutputSha256: crypto.createHash('sha256').update(raw).digest('hex'),
      servedModel: settings.servedModel,
      modelVersion: MODEL_VERSION,
    },
  };
}

async function checkModel(overrides = {}) {
  const settings = config(overrides);
  try {
    verifyAdapter(settings);
    const response = await (overrides.fetchImpl || fetch)(`${settings.url}/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return {
      ready: response.ok,
      model: settings.servedModel,
      modelVersion: MODEL_VERSION,
      adapterVerified: true,
    };
  } catch (error) {
    return {
      ready: false,
      model: settings.servedModel,
      modelVersion: MODEL_VERSION,
      adapterVerified: false,
      message: error.message,
    };
  }
}

module.exports = { checkModel, config, decide, messagesFor, verifyAdapter };
