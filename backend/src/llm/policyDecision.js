'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  canonicalRequest,
  deriveEffectiveClassification,
} = require('../../../chaincode/crimerecords/lib/policy/controlledDecision');
const {
  LLM_POLICY_ADAPTER_HASH,
  LLM_POLICY_ADAPTER_PATH,
  LLM_POLICY_MODEL,
  LLM_POLICY_TIMEOUT_MS,
  LLM_POLICY_URL,
} = require('../config');
const {
  MODEL_VERSION,
  POLICY_VERSION,
  REASON_CODES,
  REASON_DECISION,
  MODEL_REASON_CODES,
  buildUserPrompt,
  materializeDecision,
} = require('./policyPrompt');
const { groundedSystemPrompt } = require('./groundedPolicyPrompt');

const DECISIONS = Object.freeze(['allow', 'deny', 'escalate']);
const ACTIONS = Object.freeze(['view', 'export', 'annotate']);
const CLASSIFICATION_KEYS = Object.freeze([
  'action', 'decision', 'modelVersion', 'policyVersion', 'purpose', 'reasonCode',
]);
const TOP_LEVEL_KEYS = Object.freeze([
  'counterfactual', 'decision', 'decisiveAttributes', 'explanation',
  'modelVersion', 'parsedRequest', 'policyVersion', 'reasonCode',
]);
const PARSED_REQUEST_KEYS = Object.freeze([
  'action', 'caseId', 'emergencyFlag', 'purpose', 'recordId', 'recordType',
]);
const adapterHashCache = new Map();

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function verifyAdapterArtifact(adapterPath, expectedHash) {
  if (typeof adapterPath !== 'string' || adapterPath.length === 0) {
    throw new Error('LLM_POLICY_ADAPTER_PATH must identify the deployed adapter');
  }
  let artifactPath = adapterPath;
  let stat;
  try {
    stat = fs.statSync(artifactPath);
    if (stat.isDirectory()) {
      artifactPath = path.join(artifactPath, 'adapters.safetensors');
      stat = fs.statSync(artifactPath);
    }
  } catch (_error) {
    throw new Error('deployed policy adapter artifact is unavailable');
  }
  if (!stat.isFile()) throw new Error('deployed policy adapter artifact is not a file');

  const cacheKey = `${artifactPath}\0${stat.size}\0${stat.mtimeMs}`;
  let actualHash = adapterHashCache.get(cacheKey);
  if (!actualHash) {
    actualHash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    adapterHashCache.clear();
    adapterHashCache.set(cacheKey, actualHash);
  }
  if (!crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'))) {
    throw new Error('deployed policy adapter does not match LLM_POLICY_ADAPTER_HASH');
  }
  return artifactPath;
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return sha256(canonicalize(value));
}

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validateDecision(value, trusted) {
  const problems = [];
  if (!sameKeys(value, TOP_LEVEL_KEYS)) {
    return { ok: false, problems: ['output must contain exactly the required fields'] };
  }
  if (!DECISIONS.includes(value.decision)) problems.push('invalid decision');
  if (!REASON_CODES.includes(value.reasonCode)) problems.push('invalid reasonCode');
  if (REASON_DECISION[value.reasonCode] !== value.decision) {
    problems.push('reasonCode is inconsistent with decision');
  }
  if (value.policyVersion !== POLICY_VERSION) problems.push('invalid policyVersion');
  if (value.modelVersion !== MODEL_VERSION) problems.push('invalid modelVersion');
  if (!Array.isArray(value.decisiveAttributes)
      || value.decisiveAttributes.length > 16
      || value.decisiveAttributes.some((item) => !boundedString(item, 80))) {
    problems.push('invalid decisiveAttributes');
  }
  if (value.counterfactual !== null && !boundedString(value.counterfactual, 1000)) {
    problems.push('invalid counterfactual');
  }
  if (!boundedString(value.explanation, 1000)) problems.push('invalid explanation');

  const parsed = value.parsedRequest;
  if (!sameKeys(parsed, PARSED_REQUEST_KEYS)) {
    problems.push('parsedRequest must contain exactly the required fields');
  } else {
    if (!ACTIONS.includes(parsed.action)) problems.push('invalid parsed action');
    if (!boundedString(parsed.purpose, 64)) problems.push('invalid parsed purpose');
    // The recorded request must be the one the requester committed, never the
    // model's reading of it.
    const canonical = canonicalRequest(trusted);
    if (parsed.action !== canonical.action) {
      problems.push('parsedRequest action is not the committed operation');
    }
    if (parsed.purpose !== canonical.purpose) {
      problems.push('parsedRequest purpose is not the committed purpose');
    }
    if (parsed.recordId !== trusted.record.recordId) problems.push('recordId changed by model');
    if (parsed.recordType !== trusted.record.recordType) problems.push('recordType changed by model');
    if (parsed.caseId !== trusted.record.caseId) problems.push('caseId changed by model');
    if (parsed.emergencyFlag !== Boolean(trusted.requestContext.emergencyFlag)) {
      problems.push('emergencyFlag changed by model');
    }
  }
  if (REASON_CODES.includes(value.reasonCode)
      && value.policyVersion === POLICY_VERSION
      && value.modelVersion === MODEL_VERSION) {
    const expected = materializeDecision({
      decision: value.decision,
      reasonCode: value.reasonCode,
      policyVersion: value.policyVersion,
      modelVersion: value.modelVersion,
    }, trusted);
    if (hashObject(expected) !== hashObject(value)) {
      problems.push('decision does not match deterministic explanation materialization');
    }
  }
  return { ok: problems.length === 0, problems };
}

function validateClassification(value) {
  const problems = [];
  if (!sameKeys(value, CLASSIFICATION_KEYS)) {
    return { ok: false, problems: ['output must contain exactly the compact decision fields'] };
  }
  if (!ACTIONS.includes(value.action)) problems.push('invalid action');
  if (!boundedString(value.purpose, 64)) problems.push('invalid purpose');
  if (!DECISIONS.includes(value.decision)) problems.push('invalid decision');
  if (!MODEL_REASON_CODES.includes(value.reasonCode)) problems.push('invalid reasonCode');
  if (MODEL_REASON_CODES.includes(value.reasonCode)
      && REASON_DECISION[value.reasonCode] !== value.decision) {
    problems.push('reasonCode is inconsistent with decision');
  }
  if (value.policyVersion !== POLICY_VERSION) problems.push('invalid policyVersion');
  if (value.modelVersion !== MODEL_VERSION) problems.push('invalid modelVersion');
  return { ok: problems.length === 0, problems, disagreement: false };
}

function parseStrictJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('policy model returned non-JSON text');
  }
  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    throw new Error('policy model returned invalid JSON');
  }
}

function buildMessages(input) {
  return [
    { role: 'system', content: groundedSystemPrompt(input.subject, MODEL_VERSION) },
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

/**
 * A model answer that misreads the request, or that disagrees with the policy
 * evaluated on the canonical request facts, never becomes an automatic grant or
 * denial. Either failure is converted to ESCALATE for an independent AuditMSP
 * review; neither can substitute a different allow or deny.
 */
function applyPolicySafetyGuard(classification, input) {
  const result = deriveEffectiveClassification(classification, input);
  return result.effective;
}

async function decide(input, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = (options.url || LLM_POLICY_URL).replace(/\/$/, '');
  const servedModel = options.model || LLM_POLICY_MODEL;
  const adapterHash = options.adapterHash || LLM_POLICY_ADAPTER_HASH;
  const adapterPath = options.adapterPath || LLM_POLICY_ADAPTER_PATH;
  const timeoutMs = options.timeoutMs || LLM_POLICY_TIMEOUT_MS;
  if (!/^[0-9a-f]{64}$/.test(adapterHash)) {
    throw new Error('LLM_POLICY_ADAPTER_HASH must identify the deployed adapter');
  }
  const adapterVerifier = options.adapterVerifier || verifyAdapterArtifact;
  adapterVerifier(adapterPath, adapterHash);
  const messages = buildMessages(input);
  const started = Date.now();
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: servedModel,
      messages,
      stream: false,
      temperature: 0,
      top_p: 1,
      max_tokens: 192,
      adapters: adapterPath,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`policy model returned HTTP ${response.status}`);
  }
  const body = await response.json();
  const raw = String(body.choices?.[0]?.message?.content || '').trim();
  const classification = parseStrictJson(raw);
  const classificationValidation = validateClassification(classification);
  if (!classificationValidation.ok) {
    throw new Error(
      `policy model output rejected: ${classificationValidation.problems.join('; ')}`
    );
  }
  const guardedClassification = applyPolicySafetyGuard(
    classification, input
  );
  const decision = materializeDecision(guardedClassification, input);
  const validation = validateDecision(decision, input);
  if (!validation.ok) {
    throw new Error(`policy model output rejected: ${validation.problems.join('; ')}`);
  }
  return {
    decision,
    inference: {
      modelVersion: MODEL_VERSION,
      servedModel,
      adapterHash,
      promptHash: sha256(JSON.stringify(messages)),
      outputHash: hashObject(decision),
      latencyMs: Date.now() - started,
      modelClassification: classification,
    },
  };
}

module.exports = {
  REASON_DECISION,
  buildMessages,
  applyPolicySafetyGuard,
  decide,
  hashObject,
  parseStrictJson,
  validateClassification,
  validateDecision,
  verifyAdapterArtifact,
};
