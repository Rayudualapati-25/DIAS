'use strict';

/** Registering the backend's recommendation signing key on the ledger (design §6.1); safe to rerun. */

const crypto = require('crypto');
const { expect } = require('chai');
const { generateSigningKeyPem, registerRecommenderKey } = require('../src/dias/signerRegistration');
const { createRecommendationSigner } = require('../src/dias/recommendationSigner');

const REGISTRAR = Object.freeze({ org: 'audit', fabricUser: 'sp.north' });

function fakeLedger(signers = []) {
  const submitted = [];
  return {
    submitted,
    evaluate: async () => signers,
    submit: async (org, user, contract, fn, ...args) => { submitted.push([fn, ...args]); return { keyId: 'x' }; },
  };
}

describe('recommendation signer registration', () => {
  it('generates an Ed25519 private key in PEM form', () => {
    const pem = generateSigningKeyPem();
    expect(crypto.createPrivateKey(pem).asymmetricKeyType).to.equal('ed25519');
  });

  it('registers the public key once and reports an already active key', async () => {
    const signer = createRecommendationSigner({ privateKeyPem: generateSigningKeyPem() });
    const ledger = fakeLedger();
    const first = await registerRecommenderKey({ ledger, registrar: REGISTRAR, signer });
    expect(first).to.deep.equal({ keyId: signer.keyId, registered: true });
    expect(ledger.submitted).to.deep.equal([['RegisterRecommendationSigner', signer.publicKeyPem, 'dias-recommendation-service']]);
    const again = await registerRecommenderKey({
      ledger: fakeLedger([{ keyId: signer.keyId, status: 'active' }]), registrar: REGISTRAR, signer,
    });
    expect(again).to.deep.equal({ keyId: signer.keyId, registered: false });
  });

  it('refuses to reuse a key that was revoked', async () => {
    const signer = createRecommendationSigner({ privateKeyPem: generateSigningKeyPem() });
    await registerRecommenderKey({
      ledger: fakeLedger([{ keyId: signer.keyId, status: 'revoked' }]), registrar: REGISTRAR, signer,
    }).then(() => expect.fail('expected a refusal'), (error) => expect(error.message).to.match(/was revoked/));
  });
});
