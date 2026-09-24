'use strict';

const { expect } = require('chai');
const { createPolicyContextProvider } = require('../src/dias/policyContextProvider');
const { createRecommender } = require('../src/dias/recommender');
const { loadBundle } = require('../../policies/lib/bundle');
const { evaluateReference } = require('../../policies/reference-oracle/referencePolicyOracle');
const { validOutput, verifiedRequestFixture } = require('./fixtures/diasFixtures');

const MODEL = Object.freeze({
  url: 'http://127.0.0.1:9/v1',
  servedModel: 'default_model',
  modelId: 'qwen3-14b-mlx-4bit-base',
  modelFamily: 'Qwen3-14B',
  baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4',
  quantization: 'mlx-4bit',
  adapterId: null,
  adapterHash: null,
});

function replyWith(content, { status = 200, usage = { prompt_tokens: 900, completion_tokens: 60 } } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof content === 'string' && status !== 200
      ? content
      : JSON.stringify({ choices: [{ message: { content } }], usage })),
  });
}

describe('DIAS recommender', () => {
  const policyContextProvider = createPolicyContextProvider();
  const make = (fetchImpl, options) => createRecommender({
    policyContextProvider, model: MODEL, fetchImpl, options,
  });
  const input = (overrides, justification = 'Reviewing the FIR for the open investigation.') => ({
    requestId: 'REQ-0001', verifiedRequest: verifiedRequestFixture(overrides), justification,
  });

  it('returns a schema-valid recommendation with application-generated provenance', async () => {
    const result = await make(replyWith(JSON.stringify(validOutput()))).recommend(input());
    expect(result.generationStatus).to.equal('OK');
    expect(result.recommendation.recommendation).to.equal('ALLOW');
    const { provenance } = result;
    expect(provenance.requestId).to.equal('REQ-0001');
    expect(provenance.promptVersion).to.equal('dias-recommendation-prompt-v1');
    expect(provenance.responseSchemaVersion).to.equal('dias-recommendation-response-v1');
    expect(provenance.policyBundleHash).to.equal(loadBundle().bundleHash);
    expect(provenance.verifiedRequestHash).to.match(/^[0-9a-f]{64}$/);
    expect(provenance.justificationHash).to.match(/^[0-9a-f]{64}$/);
    expect(provenance.rawOutputHash).to.match(/^[0-9a-f]{64}$/);
    expect(provenance.usage).to.deep.equal({ promptTokens: 900, completionTokens: 60 });
    expect(provenance.latencyMs).to.have.keys('contextAssembly', 'inference', 'validation', 'total');
  });

  it('keeps the model recommendation even when the offline reference oracle disagrees', async () => {
    const overrides = { requester: { jurisdiction: 'district-south' } };
    const reference = evaluateReference(loadBundle().bundle, {
      requester: verifiedRequestFixture(overrides).requester,
      resource: verifiedRequestFixture(overrides).resource,
      request: verifiedRequestFixture(overrides).request,
    });
    expect(reference.recommendation).to.equal('DENY');
    const result = await make(replyWith(JSON.stringify(validOutput()))).recommend(input(overrides));
    expect(result.generationStatus).to.equal('OK');
    expect(result.recommendation.recommendation).to.equal('ALLOW');
  });

  it('reports UNAVAILABLE without a recommendation when the server cannot be reached', async () => {
    const result = await make(async () => { throw new TypeError('fetch failed'); }).recommend(input());
    expect(result.generationStatus).to.equal('UNAVAILABLE');
    expect(result.recommendation).to.equal(null);
    expect(result.provenance.errorCode).to.equal('server_unreachable');
  });

  it('reports UNAVAILABLE on a timeout and on a non-context HTTP error', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    const timedOut = await make(async () => { throw timeout; }).recommend(input());
    expect(timedOut.provenance.errorCode).to.equal('timeout');
    const serverError = await make(replyWith('internal error', { status: 500 })).recommend(input());
    expect(serverError.generationStatus).to.equal('UNAVAILABLE');
    expect(serverError.provenance.errorCode).to.equal('http_500');
  });

  it('reports INVALID_OUTPUT for malformed or out-of-contract model text', async () => {
    const prose = await make(replyWith('Allow it.')).recommend(input());
    expect(prose.generationStatus).to.equal('INVALID_OUTPUT');
    expect(prose.recommendation).to.equal(null);
    const escalate = await make(replyWith(JSON.stringify(validOutput({ recommendation: 'ESCALATE' })))).recommend(input());
    expect(escalate.generationStatus).to.equal('INVALID_OUTPUT');
    const empty = await make(async () => ({ ok: true, status: 200, text: async () => '{}' })).recommend(input());
    expect(empty.provenance.errorCode).to.equal('no_message_content');
  });

  it('reports POLICY_CONTEXT_UNAVAILABLE when the policy bundle cannot be assembled', async () => {
    const broken = createRecommender({
      policyContextProvider: createPolicyContextProvider({
        loader: () => { throw new Error('bundle missing'); },
      }),
      model: MODEL,
      fetchImpl: replyWith(JSON.stringify(validOutput())),
    });
    const result = await broken.recommend(input());
    expect(result.generationStatus).to.equal('POLICY_CONTEXT_UNAVAILABLE');
    expect(result.recommendation).to.equal(null);
  });

  it('reports CONTEXT_OVERFLOW before calling the model when the prompt exceeds its budget', async () => {
    let called = false;
    const recommender = make(async () => { called = true; return replyWith('{}')(); }, { maxPromptChars: 500 });
    const result = await recommender.recommend(input());
    expect(result.generationStatus).to.equal('CONTEXT_OVERFLOW');
    expect(called).to.equal(false);
    const serverOverflow = await make(replyWith('prompt exceeds maximum context length', { status: 400 })).recommend(input());
    expect(serverOverflow.generationStatus).to.equal('CONTEXT_OVERFLOW');
  });
});
