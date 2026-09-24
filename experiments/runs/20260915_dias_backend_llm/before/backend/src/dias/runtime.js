'use strict';

/**
 * Composition root for the DIAS runtime.
 *
 * Everything the recommendation service needs is assembled here from
 * configuration and from the governance bundle on disk, so the service itself
 * holds no knowledge of file paths, ports or keys.
 *
 * Two classes of fact are kept strictly apart:
 *   - model IDENTITY (modelId, base model, revision, quantization, adapter and
 *     its hash) comes from the registration the ledger activated. Chaincode
 *     compares submitted provenance against it, so this process may not invent
 *     it from local configuration.
 *   - model ENDPOINT (url, served alias, adapter path, decoding budget) is local
 *     operational configuration and appears in provenance only as `servedModel`.
 */

const config = require('../config');
const { loadBundle } = require('../../../policies/lib/bundle');
const { createAttestationSigner } = require('./attestation');
const { createPolicyContextProvider } = require('./policyContextProvider');
const { createRecommender } = require('./recommender');
const { createCheckpointStore } = require('./recommendationService');

/** Endpoint facts, kept out of the ledger-owned identity fields. */
function endpointSettings(settings) {
  return {
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
 * @param {object} [options.signer] pre-built attestation signer, for tests
 * @returns {{policyBundleHash: string, policyBundle: object, recommenderFor: Function,
 *   signer: object, checkpoint: object, policyContextProvider: object}}
 */
function createDiasRuntime({ settings = config, loader = loadBundle, signer } = {}) {
  const policyContextProvider = createPolicyContextProvider({
    bundlePath: settings.DIAS_POLICY_BUNDLE_PATH,
    loader,
  });
  // Fail at start-up, not on the first request: an unreadable bundle or an
  // unusable signing key is an operator problem, and discovering it one request
  // at a time would record model failures for something the model never saw.
  const policyBundle = policyContextProvider.bundleInfo();
  const attestationSigner = signer || createAttestationSigner({
    keyPath: settings.DIAS_SIGNING_KEY_PATH,
  });

  const endpoint = endpointSettings(settings);

  function recommenderFor(registration) {
    return createRecommender({
      policyContextProvider,
      model: {
        // Ledger-owned identity.
        modelId: registration.modelId,
        modelFamily: registration.modelFamily,
        baseModel: registration.baseModel,
        baseModelRevision: registration.baseModelRevision,
        quantization: registration.quantization,
        adapterId: registration.adapterId || null,
        adapterHash: registration.adapterHash || null,
        // Locally configured endpoint.
        ...endpoint,
      },
      options: {
        maxTokens: settings.DIAS_MODEL_MAX_TOKENS,
        maxPromptChars: settings.DIAS_MAX_PROMPT_CHARS,
        timeoutMs: settings.DIAS_MODEL_TIMEOUT_MS,
      },
    });
  }

  return Object.freeze({
    policyBundle,
    policyBundleHash: policyBundle.bundleHash,
    policyContextProvider,
    recommenderFor,
    signer: attestationSigner,
    checkpoint: createCheckpointStore(settings.DIAS_CHECKPOINT_PATH),
  });
}

module.exports = { createDiasRuntime, endpointSettings };
