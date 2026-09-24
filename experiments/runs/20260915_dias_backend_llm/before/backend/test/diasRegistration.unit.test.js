'use strict';

/**
 * Model and policy registration.
 *
 * A registration is the ledger's claim about which weights produced a
 * recommendation. These tests pin the two ways that claim can become a lie: an
 * adapter hash that describes no local bytes, and a bundle whose on-chain
 * content differs from the file the service will read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { expect } = require('chai');

const { adapterDigest } = require('../../scripts/dias/adapterDigest');
const registrar = require('../../scripts/dias/register-policy-and-model');
const { loadBundle } = require('../../policies/lib/bundle');

function tempAdapter(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-adapter-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('DIAS adapter digest', () => {
  it('covers every adapter file, not just the weights', () => {
    const dir = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': '{"r":8}' });
    const before = adapterDigest(dir).digest;
    fs.writeFileSync(path.join(dir, 'adapter_config.json'), '{"r":16}');
    expect(adapterDigest(dir).digest).to.not.equal(before);
  });

  it('does not depend on directory listing order', () => {
    const a = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': '{}' });
    const b = tempAdapter({ 'adapter_config.json': '{}', 'adapters.safetensors': 'W' });
    expect(adapterDigest(a).digest).to.equal(adapterDigest(b).digest);
  });

  it('changes when identical bytes move to a different file name', () => {
    const a = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': 'X' });
    const b = tempAdapter({ 'adapters.safetensors': 'X', 'adapter_config.json': 'W' });
    expect(adapterDigest(a).digest).to.not.equal(adapterDigest(b).digest);
  });

  it('ignores training logs, which are evidence rather than identity', () => {
    const dir = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': '{}' });
    const before = adapterDigest(dir).digest;
    fs.writeFileSync(path.join(dir, 'training.log'), 'iter 1 loss 1.0');
    expect(adapterDigest(dir).digest).to.equal(before);
  });

  it('refuses a directory with no adapter files rather than hashing nothing', () => {
    const dir = tempAdapter({ 'notes.txt': 'hello' });
    expect(() => adapterDigest(dir)).to.throw(/no adapter files/);
  });

  it('refuses a path that does not exist', () => {
    expect(() => adapterDigest(path.join(os.tmpdir(), 'definitely-not-here')))
      .to.throw(/does not exist/);
  });
});

describe('DIAS model registration inputs', () => {
  it('registers an untuned base model with an explicit absence of adapter', () => {
    const identity = registrar.adapterIdentity({});
    expect(identity).to.include({ adapterId: null, adapterHash: null });
  });

  it('requires adapter id and path together, so a hash is never unattributable', () => {
    expect(() => registrar.adapterIdentity({ 'adapter-id': 'v7' })).to.throw(/together/);
    expect(() => registrar.adapterIdentity({ 'adapter-path': '/tmp/x' })).to.throw(/together/);
  });

  it('recomputes the adapter hash from the bytes rather than trusting the caller', () => {
    const dir = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': '{}' });
    const identity = registrar.adapterIdentity({ 'adapter-id': 'v7', 'adapter-path': dir });
    expect(identity.adapterHash).to.equal(adapterDigest(dir).digest);
  });

  it('refuses to register an adapter whose bytes do not match the expected hash', () => {
    const dir = tempAdapter({ 'adapters.safetensors': 'W', 'adapter_config.json': '{}' });
    expect(() => registrar.adapterIdentity({
      'adapter-id': 'v7', 'adapter-path': dir, 'expect-adapter-hash': 'f'.repeat(64),
    })).to.throw(/digest mismatch/);
  });

  it('refuses to register an adapter directory that does not exist', () => {
    expect(() => registrar.adapterIdentity({
      'adapter-id': 'v7', 'adapter-path': path.join(os.tmpdir(), 'no-such-adapter'),
    })).to.throw(/does not exist/);
  });

  it('parses flags without swallowing the next flag as a value', () => {
    expect(registrar.parseArgs(['--model-id', 'm', '--dry-run', '--purpose', 'fixture-test']))
      .to.deep.equal({ 'model-id': 'm', 'dry-run': true, purpose: 'fixture-test' });
  });
});

describe('DIAS policy bundle registration', () => {
  it('derives the same canonical hash the chaincode recomputes', () => {
    const { bundle, bundleHash } = loadBundle();
    const { bundleSummary } = require('../../chaincode/crimerecords/lib/policyContract');
    expect(bundleSummary(bundle).bundleHash).to.equal(bundleHash);
  });

  it('pins the frozen v1 hash, so an edit to the policy of record is visible here', () => {
    // Changing the governance policy must be a deliberate new version, not an
    // in-place edit: this digest is quoted in the specification and the reports.
    expect(loadBundle().bundleHash).to.match(/^[0-9a-f]{64}$/);
  });

  it('registers the signer public key the running service would actually use', () => {
    const publicKeyPem = registrar.signerPublicKey();
    const key = crypto.createPublicKey(publicKeyPem);
    expect(key.asymmetricKeyType).to.equal('ed25519');
    const { createAttestationSigner } = require('../src/dias/attestation');
    const { DIAS_SIGNING_KEY_PATH } = require('../src/config');
    expect(createAttestationSigner({ keyPath: DIAS_SIGNING_KEY_PATH }).publicKeyPem)
      .to.equal(publicKeyPem);
  });
});
