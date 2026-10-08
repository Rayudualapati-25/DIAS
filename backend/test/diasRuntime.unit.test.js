'use strict';

/**
 * Composition of the v3 recommendation path: the backend itself asks the model.
 * The runtime loads the backend's Ed25519 signing key, binds the signed
 * recommender to the policy the backend holds, and gives the worker a ledger and
 * a relay identity. A missing or wrong key stops start-up with an instruction,
 * instead of recommendations failing one by one.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { createDiasRuntime } = require('../src/dias/runtime');
const config = require('../src/config');

function settings(dir, overrides = {}) {
  return { ...config, DIAS_REVIEW_STORE_DIR: path.join(dir, 'reviews'), ...overrides };
}

function signingKeyFile(dir) {
  const keyFile = path.join(dir, 'signing.pem');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return keyFile;
}

const idleLedger = Object.freeze({ submit: async () => ({}), evaluate: async () => null });
const silent = Object.freeze({ log() {}, error() {} });

describe('DIAS runtime (v3)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-runtime-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads the signing key and exposes its key identity and the policy binding', () => {
    const runtime = createDiasRuntime({
      settings: settings(dir, { DIAS_RECOMMENDER_SIGNING_KEY_FILE: signingKeyFile(dir) }),
      ledger: idleLedger,
      log: silent,
    });
    expect(runtime.signedRecommender.keyId).to.match(/^[0-9a-f]{64}$/);
    expect(runtime.policy).to.include({ policyVersion: 'dias-governance-policy-v1' });
    expect(runtime.worker).to.have.property('enqueue');
  });

  // Author's decision, 2026-10-08: the backend asks the LLM itself. Nothing in the
  // runtime depends on NODE_ENV today; this guards against a separate-service mode,
  // or a refusal of the in-backend recommender, being added back.
  it('has no separate-service mode: production builds the same in-backend recommender', () => {
    const runtime = createDiasRuntime({
      settings: settings(dir, {
        NODE_ENV: 'production', DIAS_RECOMMENDER_SIGNING_KEY_FILE: signingKeyFile(dir),
      }),
      ledger: idleLedger,
      log: silent,
    });
    expect(runtime.signedRecommender).to.have.property('recommend');
    expect(runtime).to.not.have.property('service');
    expect(runtime).to.not.have.property('recommendationMode');
    expect(Object.keys(config).filter((name) => /^DIAS_RECOMMENDER_(URL|TOKEN)$/.test(name))).to.deep.equal([]);
  });

  it('refuses to start without a signing key, naming how to create one', () => {
    expect(() => createDiasRuntime({
      settings: settings(dir, { DIAS_RECOMMENDER_SIGNING_KEY_FILE: path.join(dir, 'missing.pem') }),
      ledger: idleLedger,
    })).to.throw(/recommendation signing key not found .*scripts\/dias\/recommender-key\.js/);
  });
});
