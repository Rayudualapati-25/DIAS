'use strict';

const crypto = require('crypto');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const PolicyContract = require('../lib/policyContract');
const { loadBundle } = require('../../../policies/lib/bundle');
const { CALLERS, buildMockContext, cloneInto } = require('./testHelpers');
const { BUNDLE_JSON, FIXTURE_MODEL } = require('./diasTestWorld');

const policy = new PolicyContract();
const edKey = () => crypto.generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' }).toString();

function chain() {
  const ledger = buildMockContext({ mspId: 'AuditMSP' });
  return async (caller, txId, fn) => {
    const ctx = buildMockContext({ ...caller, txId });
    cloneInto(ledger, ctx);
    const raw = await fn(ctx);
    cloneInto(ctx, ledger);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  };
}

const bundleVersion = (version) => ({
  ...JSON.parse(BUNDLE_JSON.split('@v1').join(`@${version}`)),
  version,
});

describe('PolicyContract governance policy bundles', () => {
  it('registers the repository bundle with the same canonical hash as the policy tooling', async () => {
    const as = chain();
    const registered = await as(CALLERS.auditor, 'TX-REG', (ctx) => policy.RegisterGovernancePolicyBundle(ctx, BUNDLE_JSON));
    const tooling = loadBundle();
    expect(registered.bundleHash).to.equal(tooling.bundleHash);
    expect(registered.clauseRefs).to.deep.equal([...tooling.clauseRefs]);
    expect(registered.reviewFlags).to.include('SEALED_RECORD_COURT_REVIEW');
    expect(registered).to.include({ status: 'registered', bundleId: 'dias-governance-policy', version: 'v1' });
    expect(registered).to.not.have.property('canonicalBundle');
  });

  it('activates explicitly, refuses duplicates, supersedes, and supports rollback', async () => {
    const as = chain();
    await as(CALLERS.auditor, 'TX-1', (ctx) => policy.RegisterGovernancePolicyBundle(ctx, BUNDLE_JSON));
    await expect(as(CALLERS.auditor, 'TX-2', (ctx) => policy.RegisterGovernancePolicyBundle(ctx, BUNDLE_JSON)))
      .to.be.rejectedWith(/already registered/);
    expect(await as(CALLERS.auditor, 'TX-3', (ctx) => policy.GetActiveGovernancePolicyBundle(ctx))).to.equal(null);
    const first = await as(CALLERS.auditor, 'TX-4', (ctx) => policy.ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v1'));
    expect(first).to.include({ status: 'active', previous: null });
    expect(first).to.not.have.property('canonicalBundle');
    await expect(as(CALLERS.auditor, 'TX-5', (ctx) => policy.ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v1')))
      .to.be.rejectedWith(/already active/);
    await as(CALLERS.auditor, 'TX-6', (ctx) => policy.RegisterGovernancePolicyBundle(ctx, JSON.stringify(bundleVersion('v2'))));
    const second = await as(CALLERS.auditor, 'TX-7', (ctx) => policy.ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v2'));
    expect(second.previous).to.deep.equal({ bundleId: 'dias-governance-policy', version: 'v1' });
    const v1 = await as(CALLERS.auditor, 'TX-8', (ctx) => policy.GetGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v1'));
    expect(v1.status).to.equal('superseded');
    expect(JSON.parse(v1.canonicalBundle).bundleId).to.equal('dias-governance-policy');
    const rollback = await as(CALLERS.auditor, 'TX-9', (ctx) => policy.ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v1'));
    expect(rollback.previous.version).to.equal('v2');
    const summaries = await as(CALLERS.auditor, 'TX-10', (ctx) => policy.QueryGovernancePolicyBundles(ctx));
    expect(summaries).to.have.length(2);
    expect(summaries[0]).to.not.have.property('canonicalBundle');
    await expect(as(CALLERS.auditor, 'TX-11', (ctx) => policy.GetGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v9')))
      .to.be.rejectedWith(/is not registered/);
  });

  it('rejects malformed or unsafe bundles', async () => {
    const as = chain();
    const register = (text, tx) => as(CALLERS.auditor, tx, (ctx) => policy.RegisterGovernancePolicyBundle(ctx, text));
    const base = JSON.parse(BUNDLE_JSON);
    await expect(register('{', 'B1')).to.be.rejectedWith(/must be valid JSON/);
    await expect(register('[]', 'B2')).to.be.rejectedWith(/must be a JSON object/);
    await expect(register(JSON.stringify({ ...base, clauses: [] }), 'B3')).to.be.rejectedWith(/must contain clauses/);
    await expect(register(JSON.stringify({ ...base, version: '1' }), 'B4')).to.be.rejectedWith(/version must look like v1/);
    await expect(register(JSON.stringify({ ...base, bundleId: 'bad id' }), 'B5')).to.be.rejectedWith(/bundleId has invalid format/);
    await expect(register(JSON.stringify({ ...base, reasonCodes: { ...base.reasonCodes, SEALED_RECORD: 'ESCALATE' } }), 'B6'))
      .to.be.rejectedWith(/ALLOW or DENY/);
    await expect(register(JSON.stringify({ ...base, reviewFlags: [] }), 'B7')).to.be.rejectedWith(/reviewFlags must be an object/);
    await expect(register(JSON.stringify({ ...base, precedence: { ...base.precedence, denyOrder: ['GP-NOPE:C1@v1'] } }), 'B8'))
      .to.be.rejectedWith(/precedence must reference defined clauses/);
    await expect(register(JSON.stringify({ ...base, clauses: [...base.clauses, base.clauses[0]] }), 'B9'))
      .to.be.rejectedWith(/invalid or duplicated/);
    await expect(register(JSON.stringify({ ...base, padding: 'x'.repeat(200001) }), 'B10'))
      .to.be.rejectedWith(/at most 200000 bytes/);
  });

  it('allows only AuditMSP district heads to govern bundles', async () => {
    const as = chain();
    await expect(as(CALLERS.inspector, 'X1', (ctx) => policy.RegisterGovernancePolicyBundle(ctx, BUNDLE_JSON)))
      .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
    await expect(as(CALLERS.auditor, 'X2', (ctx) => policy.ActivateGovernancePolicyBundle(ctx, 'dias-governance-policy', 'v9')))
      .to.be.rejectedWith(/is not registered/);
  });
});

describe('PolicyContract recommendation models', () => {
  it('registers a model build with a normalized Ed25519 key and an explicit purpose', async () => {
    const as = chain();
    const registration = await as(CALLERS.auditor, 'MODELREG00000001', (ctx) => policy.RegisterRecommendationModel(
      ctx, JSON.stringify(FIXTURE_MODEL), edKey()
    ));
    expect(registration).to.include({
      registrationId: 'MODEL-MODELREG00000001', modelId: 'fixture-recommender-v1', adapterId: null,
      adapterHash: null, status: 'registered', registrationPurpose: 'fixture-test',
    });
    expect(registration.publicKeyHash).to.match(/^[0-9a-f]{64}$/);
  });

  it('validates adapter identity, key type, response schema, purpose, and fields', async () => {
    const as = chain();
    const register = (fields, key, tx) => as(CALLERS.auditor, tx, (ctx) => policy.RegisterRecommendationModel(
      ctx, JSON.stringify(fields), key
    ));
    await expect(register({ ...FIXTURE_MODEL, adapterId: 'lora-v1' }, edKey(), 'M1')).to.be.rejectedWith(/both be set or both be empty/);
    await expect(register({ ...FIXTURE_MODEL, responseSchemaVersion: 'v0' }, edKey(), 'M2')).to.be.rejectedWith(/'responseSchemaVersion' must be one of/);
    await expect(register({ ...FIXTURE_MODEL, registrationPurpose: 'production' }, edKey(), 'M3')).to.be.rejectedWith(/'registrationPurpose' must be one of/);
    await expect(register({ ...FIXTURE_MODEL, trainedOnTest: true }, edKey(), 'M4')).to.be.rejectedWith(/unknown fields/);
    await expect(register(FIXTURE_MODEL, 'not a key', 'M5')).to.be.rejectedWith(/publicKeyPem is invalid/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    await expect(register(FIXTURE_MODEL, rsa, 'M6')).to.be.rejectedWith(/Ed25519/);
    await expect(as(CALLERS.auditor, 'M7', (ctx) => policy.RegisterRecommendationModel(ctx, '{', edKey())))
      .to.be.rejectedWith(/must be valid JSON/);
    const tuned = await register({
      ...FIXTURE_MODEL, modelId: 'qwen3-14b-dias-lora-v2', adapterId: 'qwen3-14b-dias-lora-v2',
      adapterHash: 'a'.repeat(64), registrationPurpose: 'fine-tuned-candidate',
    }, edKey(), 'M8');
    expect(tuned.adapterHash).to.equal('a'.repeat(64));
  });

  it('activates a registration, records the previous one, and supports rollback', async () => {
    const as = chain();
    const base = await as(CALLERS.auditor, 'BASEMODEL0000001', (ctx) => policy.RegisterRecommendationModel(ctx, JSON.stringify({
      ...FIXTURE_MODEL, modelId: 'qwen3-14b-mlx-4bit-base', registrationPurpose: 'research-baseline',
    }), edKey()));
    const tuned = await as(CALLERS.auditor, 'TUNEDMODEL000001', (ctx) => policy.RegisterRecommendationModel(ctx, JSON.stringify({
      ...FIXTURE_MODEL, modelId: 'qwen3-14b-dias-lora-v2', adapterId: 'lora-v2', adapterHash: 'b'.repeat(64),
      registrationPurpose: 'fine-tuned-candidate',
    }), edKey()));
    expect(await as(CALLERS.auditor, 'G0', (ctx) => policy.GetActiveRecommendationModel(ctx))).to.equal(null);
    await as(CALLERS.auditor, 'A1', (ctx) => policy.ActivateRecommendationModel(ctx, base.registrationId));
    const active = await as(CALLERS.auditor, 'A2', (ctx) => policy.ActivateRecommendationModel(ctx, tuned.registrationId));
    expect(active.previousRegistrationId).to.equal(base.registrationId);
    await expect(as(CALLERS.auditor, 'A3', (ctx) => policy.ActivateRecommendationModel(ctx, tuned.registrationId)))
      .to.be.rejectedWith(/already active/);
    const rolledBack = await as(CALLERS.auditor, 'A4', (ctx) => policy.ActivateRecommendationModel(ctx, base.registrationId));
    expect(rolledBack).to.include({ modelId: 'qwen3-14b-mlx-4bit-base', previousRegistrationId: tuned.registrationId });
    const all = await as(CALLERS.auditor, 'Q1', (ctx) => policy.QueryRecommendationModels(ctx));
    expect(all.find((item) => item.registrationId === tuned.registrationId).status).to.equal('inactive');
    expect((await as(CALLERS.auditor, 'G1', (ctx) => policy.GetActiveRecommendationModel(ctx))).modelId)
      .to.equal('qwen3-14b-mlx-4bit-base');
    await expect(as(CALLERS.auditor, 'A5', (ctx) => policy.ActivateRecommendationModel(ctx, 'MODEL-missing')))
      .to.be.rejectedWith(/does not exist/);
    await expect(as(CALLERS.auditor, 'A6', (ctx) => policy.ActivateRecommendationModel(ctx, 'bad id')))
      .to.be.rejectedWith(/invalid format/);
    await expect(as(CALLERS.inspector, 'A7', (ctx) => policy.ActivateRecommendationModel(ctx, base.registrationId)))
      .to.be.rejectedWith(/requires membership/);
  });
});
