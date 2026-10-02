'use strict';

/**
 * Composition of the v3 recommendation path: the runtime loads the service's
 * Ed25519 key, binds the service to the policy the backend holds, and gives the
 * worker a ledger and a relay identity. A missing or wrong key stops start-up with
 * an instruction, instead of recommendations failing one by one.
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

describe('DIAS runtime (v3)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-runtime-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads the signing key and exposes the service key identity and the policy binding', () => {
    const keyFile = path.join(dir, 'signing.pem');
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const runtime = createDiasRuntime({
      settings: settings(dir, { DIAS_RECOMMENDER_SIGNING_KEY_FILE: keyFile }),
      ledger: { submit: async () => ({}), evaluate: async () => null },
      log: { log() {}, error() {} },
    });
    expect(runtime.service.keyId).to.match(/^[0-9a-f]{64}$/);
    expect(runtime.policy).to.include({ policyVersion: 'dias-governance-policy-v1' });
    expect(runtime.worker).to.have.property('enqueue');
  });

  it('refuses to start without a signing key, naming how to create one', () => {
    expect(() => createDiasRuntime({
      settings: settings(dir, { DIAS_RECOMMENDER_SIGNING_KEY_FILE: path.join(dir, 'missing.pem') }),
      ledger: { submit: async () => ({}), evaluate: async () => null },
    })).to.throw(/recommendation signing key not found .*scripts\/dias\/recommender-key\.js/);
  });
});
