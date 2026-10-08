'use strict';

/**
 * DIAS recommendation call: verified request + governance policy context +
 * untrusted justification -> an advisory ALLOW/DENY recommendation, or an
 * explicit generation-failure status with no recommendation.
 *
 * Provenance is generated here, never by the model. The recommender returns the
 * model's recommendation unchanged whenever it satisfies the response schema; it
 * never consults a rule engine and never grants access.
 */

const { sha256, hashObject } = require('../../../policies/lib/bundle');
const {
  GENERATION_STATUS, RESPONSE_SCHEMA_VERSION,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationSchema');
const {
  verifiedRequestHash,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const verifiedRequestV1 = require('../../../chaincode/crimerecords/lib/dias/verifiedRequestV1');
const {
  requesterClaimsHash, validateRequesterClaims,
} = require('../../../chaincode/crimerecords/lib/dias/requesterClaims');
const { DOMAINS, hashText } = require('../../../chaincode/crimerecords/lib/dias/commitments');
const {
  PROMPT_VERSION, PROMPT_VERSION_V1, buildRecommendationMessages, buildRecommendationMessagesV1,
} = require('./recommendationPrompt');
const { parseRecommendation } = require('./recommendationContract');
const trace = require('../util/trace');

const PROVENANCE_SCHEMA_VERSION = 'dias-recommendation-provenance-v1';
const DEFAULTS = Object.freeze({ maxPromptChars: 24000, maxTokens: 256, timeoutMs: 60000 });

/**
 * v2 is the live prompt (verified context plus a separate claims block). v1 is
 * kept only so the published dataset's evaluation can be reproduced exactly: its
 * inputs are v1-shaped and its provenance hashes follow the v1 rules.
 */
const PROMPTS = Object.freeze({
  v2: Object.freeze({
    version: PROMPT_VERSION,
    build: ({ verifiedRequest, requesterClaims, policyContext, justification }) => (
      buildRecommendationMessages({ verifiedRequest, requesterClaims, policyContext, justification })),
    inputProvenance: ({ verifiedRequest, requesterClaims, justification }) => ({
      verifiedRequestHash: verifiedRequestHash(verifiedRequest),
      requesterClaimsHash: requesterClaimsHash(requesterClaims),
      justificationHash: hashText(DOMAINS.JUSTIFICATION, String(justification ?? '')),
    }),
    checkInput: ({ requesterClaims }) => {
      const problems = validateRequesterClaims(requesterClaims);
      if (problems.length > 0) throw new Error(`requester claims are invalid: ${problems.join('; ')}`);
    },
  }),
  v1: Object.freeze({
    version: PROMPT_VERSION_V1,
    build: ({ verifiedRequest, policyContext, justification }) => (
      buildRecommendationMessagesV1({ verifiedRequest, policyContext, justification })),
    inputProvenance: ({ verifiedRequest, justification }) => ({
      verifiedRequestHash: verifiedRequestV1.verifiedRequestHash(verifiedRequest),
      justificationHash: sha256(String(justification ?? '')),
    }),
    checkInput: () => {},
  }),
});
const CONTEXT_OVERFLOW_PATTERN = /context|too long|maximum.*length|exceed/i;
const MAX_ERROR_DETAIL = 300;

const round = (value) => Math.round(value * 1000) / 1000;
const detail = (value) => String(value ?? '').slice(0, MAX_ERROR_DETAIL);

function modelProvenance(model) {
  return {
    modelId: model.modelId,
    modelFamily: model.modelFamily,
    baseModel: model.baseModel,
    baseModelRevision: model.baseModelRevision,
    quantization: model.quantization,
    adapterId: model.adapterId || null,
    adapterHash: model.adapterHash || null,
    servedModel: model.servedModel,
  };
}

function createRecommender({
  policyContextProvider,
  model,
  fetchImpl = fetch,
  now = () => new Date(),
  clock = () => performance.now(),
  options = {},
  prompt = 'v2',
}) {
  if (!policyContextProvider || !model || !model.url) {
    throw new Error('recommender requires a policy context provider and a model endpoint');
  }
  if (!Object.prototype.hasOwnProperty.call(PROMPTS, prompt)) {
    throw new Error(`prompt must be one of ${Object.keys(PROMPTS).sort().join(', ')}`);
  }
  const promptVersion = PROMPTS[prompt];
  const settings = { ...DEFAULTS, ...options };

  async function callModel(messages) {
    const body = {
      model: model.servedModel,
      messages,
      stream: false,
      temperature: 0,
      top_p: 1,
      max_tokens: settings.maxTokens,
      ...(model.adapterPath ? { adapters: model.adapterPath } : {}),
    };
    const response = await fetchImpl(`${model.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  }

  async function recommend({ requestId, verifiedRequest, requesterClaims, justification }) {
    const startedAt = clock();
    const input = { verifiedRequest, requesterClaims, justification };
    promptVersion.checkInput(input);
    const provenance = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      requestId,
      ...modelProvenance(model),
      promptVersion: promptVersion.version,
      responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
      ...promptVersion.inputProvenance(input),
      decoding: { temperature: 0, topP: 1, maxTokens: settings.maxTokens },
      inferenceStartedAtUtc: now().toISOString(),
    };
    const finish = (generationStatus, extra = {}) => ({
      generationStatus,
      recommendation: extra.recommendation || null,
      provenance: {
        ...provenance,
        ...extra.provenance,
        generationStatus,
        latencyMs: { ...extra.latencyMs, total: round(clock() - startedAt) },
        inferenceCompletedAtUtc: now().toISOString(),
      },
    });

    let policyContext;
    try {
      policyContext = policyContextProvider.assemble(verifiedRequest);
    } catch (error) {
      return finish(GENERATION_STATUS.POLICY_CONTEXT_UNAVAILABLE, {
        provenance: { errorCode: 'policy_context_unavailable', errorDetail: detail(error.message) },
      });
    }
    const contextReady = clock();
    const policyProvenance = {
      policyBundleId: policyContext.bundleId,
      policyBundleVersion: policyContext.version,
      policyBundleHash: policyContext.bundleHash,
      policyContextHash: policyContext.contextHash,
    };
    const messages = promptVersion.build({ ...input, policyContext });
    const promptChars = messages.reduce((total, message) => total + message.content.length, 0);
    const promptProvenance = { ...policyProvenance, promptHash: hashObject(messages), promptChars };
    const contextAssembly = round(contextReady - startedAt);
    if (promptChars > settings.maxPromptChars) {
      return finish(GENERATION_STATUS.CONTEXT_OVERFLOW, {
        provenance: { ...promptProvenance, errorCode: 'prompt_exceeds_budget', errorDetail: `${promptChars} characters` },
        latencyMs: { contextAssembly },
      });
    }

    let reply;
    const inferenceStarted = clock();
    try {
      reply = await callModel(messages);
    } catch (error) {
      const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
      return finish(GENERATION_STATUS.UNAVAILABLE, {
        provenance: { ...promptProvenance, errorCode: timedOut ? 'timeout' : 'server_unreachable', errorDetail: detail(error.message) },
        latencyMs: { contextAssembly, inference: round(clock() - inferenceStarted) },
      });
    }
    const inference = round(clock() - inferenceStarted);
    if (!reply.ok) {
      const overflow = CONTEXT_OVERFLOW_PATTERN.test(reply.text);
      return finish(overflow ? GENERATION_STATUS.CONTEXT_OVERFLOW : GENERATION_STATUS.UNAVAILABLE, {
        provenance: { ...promptProvenance, errorCode: `http_${reply.status}`, errorDetail: detail(reply.text) },
        latencyMs: { contextAssembly, inference },
      });
    }

    const validationStarted = clock();
    let content = null;
    let usage = {};
    try {
      const body = JSON.parse(reply.text);
      content = body.choices?.[0]?.message?.content ?? null;
      usage = body.usage || {};
    } catch (_error) {
      content = null;
    }
    const usageProvenance = {
      promptTokens: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : null,
      completionTokens: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : null,
    };
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
    trace.emit('model.response', {
      requestId,
      promptChars,
      promptTokens: usageProvenance.promptTokens,
      completionTokens: usageProvenance.completionTokens,
      cachedPromptTokens: Number.isInteger(cachedTokens) ? cachedTokens : null,
      inferenceMs: inference,
    });
    if (typeof content !== 'string') {
      return finish(GENERATION_STATUS.INVALID_OUTPUT, {
        provenance: { ...promptProvenance, usage: usageProvenance, errorCode: 'no_message_content', errorDetail: detail(reply.text) },
        latencyMs: { contextAssembly, inference, validation: round(clock() - validationStarted) },
      });
    }
    const policy = policyContextProvider.bundleInfo();
    const parsed = parseRecommendation(content, policy);
    return finish(parsed.status, {
      recommendation: parsed.recommendation,
      provenance: {
        ...promptProvenance,
        usage: usageProvenance,
        rawOutputHash: sha256(content),
        parserStatus: parsed.status,
        parserErrors: parsed.errors,
        parserTolerances: parsed.tolerances,
      },
      latencyMs: { contextAssembly, inference, validation: round(clock() - validationStarted) },
    });
  }

  /**
   * A failure the backend determined before or instead of an inference call:
   * a committed-hash mismatch, or a policy bundle that is not the active one.
   * The hashes come from the ledger rather than from anything recomputed here,
   * because the point of these statuses is that what we hold cannot be trusted.
   * Provenance has exactly one author, so this shares the shape `recommend`
   * produces and no caller ever assembles provenance of its own.
   */
  function unavailable({
    requestId, verifiedRequestHash: committedRequestHash, requesterClaimsHash: committedClaimsHash = null,
    justificationHash, generationStatus, errorCode, errorDetail,
  }) {
    const startedAt = clock();
    const startedAtUtc = now().toISOString();
    return {
      generationStatus,
      recommendation: null,
      provenance: {
        schemaVersion: PROVENANCE_SCHEMA_VERSION,
        requestId,
        ...modelProvenance(model),
        promptVersion: promptVersion.version,
        responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
        verifiedRequestHash: committedRequestHash,
        ...(prompt === 'v2' ? { requesterClaimsHash: committedClaimsHash } : {}),
        justificationHash,
        decoding: { temperature: 0, topP: 1, maxTokens: settings.maxTokens },
        inferenceStartedAtUtc: startedAtUtc,
        generationStatus,
        errorCode,
        errorDetail: detail(errorDetail),
        latencyMs: { total: round(clock() - startedAt) },
        inferenceCompletedAtUtc: now().toISOString(),
      },
    };
  }

  return Object.freeze({ recommend, unavailable });
}

module.exports = { PROVENANCE_SCHEMA_VERSION, createRecommender };
