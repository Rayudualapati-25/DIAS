'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const { canonicalize } = require('../lib/util/validate');
const {
  attestationPayload, validateProvenance, verifyAttestation,
} = require('../lib/dias/recommendationProvenance');

const REGISTRATION = Object.freeze({
  modelId: 'qwen3-14b-mlx-4bit-base',
  modelFamily: 'Qwen3-14B',
  baseModel: 'mlx-community/Qwen3-14B-4bit',
  baseModelRevision: 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4',
  quantization: 'mlx-4bit',
  adapterId: null,
  adapterHash: null,
  promptVersion: 'dias-recommendation-prompt-v1',
});
const BUNDLE = Object.freeze({ bundleId: 'dias-governance-policy', version: 'v1', bundleHash: 'a'.repeat(64) });

function provenance(overrides = {}) {
  return {
    schemaVersion: 'dias-recommendation-provenance-v1',
    requestId: 'REQ-1',
    ...REGISTRATION,
    servedModel: 'default_model',
    responseSchemaVersion: 'dias-recommendation-response-v1',
    verifiedRequestHash: 'b'.repeat(64),
    justificationHash: 'c'.repeat(64),
    decoding: { temperature: 0, topP: 1, maxTokens: 256 },
    inferenceStartedAtUtc: '2026-08-05T12:00:00.000Z',
    inferenceCompletedAtUtc: '2026-08-05T12:00:05.000Z',
    generationStatus: 'OK',
    policyBundleId: BUNDLE.bundleId,
    policyBundleVersion: BUNDLE.version,
    policyBundleHash: BUNDLE.bundleHash,
    policyContextHash: 'd'.repeat(64),
    promptHash: 'e'.repeat(64),
    rawOutputHash: 'f'.repeat(64),
    latencyMs: { contextAssembly: 1.5, inference: 4800, validation: 0.4, total: 4802 },
    ...overrides,
  };
}

const expected = (overrides = {}) => ({
  requestId: 'REQ-1',
  verifiedRequestHash: 'b'.repeat(64),
  justificationHash: 'c'.repeat(64),
  generationStatus: 'OK',
  model: REGISTRATION,
  policyBundle: BUNDLE,
  ...overrides,
});

describe('DIAS recommendation provenance', () => {
  it('accepts complete provenance bound to the request, model, and policy bundle', () => {
    expect(validateProvenance(provenance(), expected())).to.deep.equal([]);
  });

  it('rejects provenance bound to a different request, facts, or justification', () => {
    expect(validateProvenance(provenance({ requestId: 'REQ-2' }), expected()))
      .to.include('provenance.requestId does not match the request');
    expect(validateProvenance(provenance({ verifiedRequestHash: '0'.repeat(64) }), expected()))
      .to.include('provenance.verifiedRequestHash does not match the committed verified request');
    expect(validateProvenance(provenance({ justificationHash: '0'.repeat(64) }), expected()))
      .to.include('provenance.justificationHash does not match the committed justification');
  });

  it('rejects an unregistered model, adapter, prompt, or policy bundle', () => {
    expect(validateProvenance(provenance({ adapterHash: '1'.repeat(64) }), expected()))
      .to.include('provenance.adapterHash does not match the registered model');
    expect(validateProvenance(provenance({ promptVersion: 'other' }), expected()))
      .to.include('provenance.promptVersion does not match the registered model');
    expect(validateProvenance(provenance({ policyBundleHash: '2'.repeat(64) }), expected()))
      .to.include('provenance.policyBundleHash does not match the active policy bundle');
  });

  it('requires output hashes for OK and tolerates absent policy fields on failures', () => {
    expect(validateProvenance(provenance({ rawOutputHash: undefined }), expected()))
      .to.include('provenance.rawOutputHash must be a SHA-256 hash');
    const failure = provenance({
      generationStatus: 'POLICY_CONTEXT_UNAVAILABLE', policyBundleId: undefined,
      policyBundleVersion: undefined, policyBundleHash: undefined, errorDetail: 'bundle missing',
    });
    expect(validateProvenance(failure, expected({ generationStatus: 'POLICY_CONTEXT_UNAVAILABLE' }))).to.deep.equal([]);
    expect(validateProvenance(provenance({ generationStatus: 'UNAVAILABLE', policyBundleHash: '3'.repeat(64) }),
      expected({ generationStatus: 'UNAVAILABLE' })))
      .to.include('provenance.policyBundleHash does not match the active policy bundle');
  });

  it('bounds latency, error detail, and total size', () => {
    expect(validateProvenance(provenance({ latencyMs: { total: -1 } }), expected()))
      .to.include('provenance.latencyMs.total is out of range');
    expect(validateProvenance(provenance({ latencyMs: 5 }), expected()))
      .to.include('provenance.latencyMs must be an object');
    expect(validateProvenance(provenance({ errorDetail: 'x'.repeat(301) }), expected()))
      .to.include('provenance.errorDetail must be a string of at most 300 characters');
    expect(validateProvenance(provenance({ padding: 'x'.repeat(9000) }), expected()))
      .to.deep.equal(['provenance exceeds the size limit']);
    expect(validateProvenance(null, expected())).to.deep.equal(['provenance must be an object']);
  });
});

describe('DIAS recommendation attestation', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const registration = { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const payload = attestationPayload({
    requestId: 'REQ-1', verifiedRequestHash: 'b'.repeat(64), justificationHash: 'c'.repeat(64),
    generationStatus: 'OK', output: { recommendation: 'DENY' }, provenance: provenance(),
  });
  const sign = (value) => crypto.sign(null, Buffer.from(canonicalize(value), 'utf8'), privateKey).toString('base64');

  it('verifies a signature from the registered operator key', () => {
    expect(verifyAttestation(registration, payload, sign(payload))).to.equal(true);
  });

  it('rejects a tampered payload and malformed signatures or keys', () => {
    const tampered = { ...payload, output: { recommendation: 'ALLOW' } };
    expect(() => verifyAttestation(registration, tampered, sign(payload))).to.throw(/verification failed/);
    expect(() => verifyAttestation(registration, payload, 'not-a-signature')).to.throw(/invalid format/);
    expect(() => verifyAttestation({ publicKeyPem: 'nope' }, payload, sign(payload))).to.throw(/public key is invalid/);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(() => verifyAttestation({ publicKeyPem: rsa.export({ type: 'spki', format: 'pem' }).toString() }, payload, sign(payload)))
      .to.throw(/not Ed25519/);
  });
});
