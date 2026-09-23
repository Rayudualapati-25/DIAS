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
const { PROMPT_VERSION, buildRecommendationMessages } = require('./recommendationPrompt');
const { parseRecommendation } = require('./recommendationContract');

const PROVENANCE_SCHEMA_VERSION = 'dias-recommendation-provenance-v1';
const DEFAULTS = Object.freeze({ maxPromptChars: 24000, maxTokens: 256, timeoutMs: 60000 });
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
}) {
  if (!policyContextProvider || !model || !model.url) {
    throw new Error('recommender requires a policy context provider and a model endpoint');
  }
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

  async function recommend({ requestId, verifiedRequest, justification }) {
    const startedAt = clock();
    const provenance = {
      schemaVersion: PROVENANCE_SCHEMA_VERSION,
      requestId,
      ...modelProvenance(model),
      promptVersion: PROMPT_VERSION,
      responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
      verifiedRequestHash: verifiedRequestHash(verifiedRequest),
      justificationHash: sha256(String(justification ?? '')),
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
    const messages = buildRecommendationMessages({ verifiedRequest, policyContext, justification });
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
   * A failure this service determined before or instead of an inference call:
   * a committed-hash mismatch, or a policy bundle that is not the active one.
   * The hashes come from the ledger rather than from anything recomputed here,
   * because the point of these statuses is that what we hold cannot be trusted.
   * Provenance has exactly one author, so this shares the shape `recommend`
   * produces and no caller ever assembles provenance of its own.
   */
  function unavailable({
    requestId, verifiedRequestHash: committedRequestHash, justificationHash,
    generationStatus, errorCode, errorDetail,
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
        promptVersion: PROMPT_VERSION,
        responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
        verifiedRequestHash: committedRequestHash,
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
