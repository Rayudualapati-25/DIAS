'use strict';

/**
 * The recommendation object M (design §6, §11): exactly what the auditor reviews
 * and what h_M commits to. It must be deterministic for the same model output —
 * no timestamps or latencies — so a retry produces the same digest, and it must
 * always be representable as canonical JSON.
 */

const { expect } = require('chai');
const {
  RECOMMENDATION_OBJECT_SCHEMA_VERSION, buildRecommendationObject, modelVersionOf, recommendationHashOf,
} = require('../src/dias/recommendationObject');
const { hashCanonical } = require('../../chaincode/crimerecords/lib/dias/commitments');
const { validOutput } = require('./fixtures/diasFixtures');

const MODEL = Object.freeze({
  modelId: 'qwen3-14b-dias-v7', modelFamily: 'qwen3', baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4', quantization: '4bit',
  adapterId: 'qwen3-14b-dias-lora-v7', adapterHash: '348f4ca5'.padEnd(64, '0'), servedModel: 'default_model',
});
const BINDING = Object.freeze({
  contextHash: '1'.repeat(64), claimsHash: '2'.repeat(64), justificationHash: '3'.repeat(64),
  policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64),
});

function result(overrides = {}) {
  return {
    generationStatus: 'OK',
    recommendation: validOutput({ recommendation: 'DENY', reason_code: 'NOT_ASSIGNED', policy_refs: ['GP-ASSIGN:C1@v1'] }),
    provenance: {
      promptVersion: 'dias-recommendation-prompt-v2', responseSchemaVersion: 'dias-recommendation-response-v1',
      decoding: { temperature: 0, topP: 1, maxTokens: 512 }, policyBundleHash: 'b'.repeat(64),
      parserStatus: 'OK', parserErrors: [], parserTolerances: [], rawOutputHash: 'c'.repeat(64),
      latencyMs: { total: 8123 }, inferenceStartedAtUtc: '2026-10-02T10:00:00.000Z', usage: { promptTokens: 900 },
    },
    ...overrides,
  };
}

describe('recommendation object M', () => {
  it('holds the recommendation, its status, the bindings and the model, but no timing', () => {
    const object = buildRecommendationObject({ requestId: 'REQ-1', result: result(), binding: BINDING, model: MODEL });
    expect(object).to.include({
      schemaVersion: RECOMMENDATION_OBJECT_SCHEMA_VERSION, requestId: 'REQ-1',
      generationStatus: 'OK', recommendation: 'DENY',
    });
    expect(object.output.reason_code).to.equal('NOT_ASSIGNED');
    expect(object.error).to.equal(null);
    expect(object.provenance).to.include({ ...BINDING, modelVersion: modelVersionOf(MODEL) });
    expect(JSON.stringify(object)).to.not.match(/latencyMs|inferenceStartedAtUtc|usage/);
  });

  it('records a failed generation as a status and an error, with no recommendation', () => {
    const failed = result({
      generationStatus: 'INVALID_OUTPUT', recommendation: null,
      provenance: { ...result().provenance, errorCode: 'no_message_content', errorDetail: 'empty' },
    });
    const object = buildRecommendationObject({ requestId: 'REQ-2', result: failed, binding: BINDING, model: MODEL });
    expect(object).to.include({ generationStatus: 'INVALID_OUTPUT', recommendation: null, output: null });
    expect(object.error).to.deep.equal({ code: 'no_message_content', detail: 'empty' });
  });

  it('is deterministic: the same output gives the same digest whatever the timing', () => {
    const first = buildRecommendationObject({ requestId: 'REQ-1', result: result(), binding: BINDING, model: MODEL });
    const later = result();
    later.provenance = { ...later.provenance, latencyMs: { total: 99999 }, inferenceStartedAtUtc: '2026-10-03T00:00:00Z' };
    const second = buildRecommendationObject({ requestId: 'REQ-1', result: later, binding: BINDING, model: MODEL });
    expect(recommendationHashOf(second)).to.equal(recommendationHashOf(first));
    expect(recommendationHashOf(first)).to.equal(hashCanonical('recommendation', first));
  });

  it('replaces unpaired surrogates from model or server text so the object can always be hashed', () => {
    const odd = result({ recommendation: validOutput({ reason: 'bad \ud800 text' }) });
    const object = buildRecommendationObject({ requestId: 'REQ-3', result: odd, binding: BINDING, model: MODEL });
    expect(object.output.reason).to.equal('bad � text');
    expect(() => recommendationHashOf(object)).to.not.throw();
  });

  it('names the model as base@revision plus the adapter digest', () => {
    expect(modelVersionOf(MODEL)).to.equal(
      `mlx-community/Qwen3-14B-4bit@a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4+adapter:${MODEL.adapterHash}`);
    expect(modelVersionOf({ ...MODEL, adapterHash: null })).to.equal(
      'mlx-community/Qwen3-14B-4bit@a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4');
  });
});
