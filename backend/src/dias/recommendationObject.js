'use strict';

/**
 * The recommendation object M (dias-recommendation-object-v1; design §6, §11).
 *
 * M is what the auditor reviews and what h_M commits to: the generation status,
 * the recommendation (or the error when there is none), the normalized model
 * output, the bindings to the request (context, claims and justification digests,
 * policy) and the model provenance. Timestamps, latencies and token counts are
 * kept outside M, so the same deterministic model output always yields the same
 * object and digest, which keeps retries safe.
 *
 * Model and server text can contain unpaired surrogates (a JSON "\ud800" escape
 * parses to one). Canonical JSON cannot represent them, so they are replaced by
 * U+FFFD here; the replacement is deterministic and the result is what is stored
 * and hashed.
 */

const { DOMAINS, hashCanonical } = require('../../../chaincode/crimerecords/lib/dias/commitments');

const RECOMMENDATION_OBJECT_SCHEMA_VERSION = 'dias-recommendation-object-v1';
const UNPAIRED_SURROGATES = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A copy of a JSON value with every string made well formed and non-integer numbers dropped. */
function wellFormed(value) {
  if (typeof value === 'string') return value.replace(UNPAIRED_SURROGATES, '�');
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [wellFormed(key), wellFormed(item)]));
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return String(value);
  return value;
}

/** base@revision, plus the adapter digest when an adapter is served. */
function modelVersionOf(model) {
  const base = `${model.baseModel}@${model.baseModelRevision}`;
  return model.adapterHash ? `${base}+adapter:${model.adapterHash}` : base;
}

function buildRecommendationObject({ requestId, result, binding, model }) {
  const provenance = result.provenance || {};
  const succeeded = result.generationStatus === 'OK' && result.recommendation;
  return wellFormed({
    schemaVersion: RECOMMENDATION_OBJECT_SCHEMA_VERSION,
    requestId,
    generationStatus: result.generationStatus,
    recommendation: succeeded ? result.recommendation.recommendation : null,
    output: succeeded ? result.recommendation : null,
    error: succeeded ? null : {
      code: provenance.errorCode || null,
      detail: provenance.errorDetail || null,
    },
    provenance: {
      contextHash: binding.contextHash,
      claimsHash: binding.claimsHash,
      justificationHash: binding.justificationHash,
      policyVersion: binding.policyVersion,
      policyHash: binding.policyHash,
      modelVersion: modelVersionOf(model),
      model: {
        modelId: model.modelId,
        modelFamily: model.modelFamily,
        baseModel: model.baseModel,
        baseModelRevision: model.baseModelRevision,
        quantization: model.quantization,
        adapterId: model.adapterId || null,
        adapterHash: model.adapterHash || null,
        servedModel: model.servedModel,
      },
      promptVersion: provenance.promptVersion || null,
      responseSchemaVersion: provenance.responseSchemaVersion || null,
      decoding: provenance.decoding || null,
      policyBundleHash: provenance.policyBundleHash || null,
      parserStatus: provenance.parserStatus || null,
      parserErrors: provenance.parserErrors || [],
      parserTolerances: provenance.parserTolerances || [],
      rawOutputHash: provenance.rawOutputHash || null,
    },
  });
}

/** h_M. */
const recommendationHashOf = (object) => hashCanonical(DOMAINS.RECOMMENDATION, object);

module.exports = {
  RECOMMENDATION_OBJECT_SCHEMA_VERSION,
  buildRecommendationObject,
  modelVersionOf,
  recommendationHashOf,
  wellFormed,
};
