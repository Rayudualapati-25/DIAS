'use strict';

/**
 * Composition root for the DIAS backend recommender.
 *
 * The backend itself calls the LLM, so everything the recommendation needs is
 * assembled here from configuration and from the governance policy bundle on
 * disk: the policy context, the model identity and endpoint, the off-chain review
 * store, and the worker that answers requests one at a time.
 */

const config = require('../config');
const { loadBundle } = require('../../../policies/lib/bundle');
const { createPolicyContextProvider } = require('./policyContextProvider');
const { createRecommender } = require('./recommender');
const { createReviewStore } = require('./reviewStore');
const { createRecommendationWorker } = require('./recommendationWorker');

/** Model identity and endpoint, both from local configuration. */
function modelSettings(settings) {
  return {
    modelId: settings.DIAS_MODEL_ID,
    modelFamily: settings.DIAS_MODEL_FAMILY,
    baseModel: settings.DIAS_BASE_MODEL,
    baseModelRevision: settings.DIAS_BASE_MODEL_REVISION,
    quantization: settings.DIAS_MODEL_QUANTIZATION,
    adapterId: settings.DIAS_ADAPTER_ID || null,
    adapterHash: settings.DIAS_ADAPTER_HASH || null,
    url: settings.DIAS_MODEL_URL,
    servedModel: settings.DIAS_MODEL_SERVED_NAME,
    adapterPath: settings.DIAS_ADAPTER_PATH || null,
  };
}

/**
 * Build the DIAS runtime.
 *
 * @param {object} options
 * @param {object} [options.settings] configuration (defaults to backend config)
 * @param {Function} [options.loader] bundle loader, for tests
 * @param {object} [options.log] logger, for tests
 */
function createDiasRuntime({ settings = config, loader = loadBundle, log = console } = {}) {
  const policyContextProvider = createPolicyContextProvider({
    bundlePath: settings.DIAS_POLICY_BUNDLE_PATH,
    loader,
  });
  // Fail at start-up, not on the first request: an unreadable bundle is an
  // operator problem, not a model failure.
  const policyBundle = policyContextProvider.bundleInfo();
  const recommender = createRecommender({
    policyContextProvider,
    model: modelSettings(settings),
    options: {
      maxTokens: settings.DIAS_MODEL_MAX_TOKENS,
      maxPromptChars: settings.DIAS_MAX_PROMPT_CHARS,
      timeoutMs: settings.DIAS_MODEL_TIMEOUT_MS,
    },
  });
  const store = createReviewStore(settings.DIAS_REVIEW_STORE_DIR);
  const worker = createRecommendationWorker({ store, recommender, log });
  return Object.freeze({ policyBundle, recommender, store, worker });
}

let shared = null;

/** The process-wide runtime, created on first use so importing a route has no side effects. */
function getDiasRuntime() {
  if (!shared) shared = createDiasRuntime();
  return shared;
}

module.exports = { createDiasRuntime, getDiasRuntime, modelSettings };
