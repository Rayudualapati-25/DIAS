'use strict';

/** The backend's recommendation signing key. */

const crypto = require('crypto');
const {
  provenanceMessage, signerKeyIdOf,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationCommitment');

function createRecommendationSigner({ privateKeyPem }) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (_error) {
    throw new Error('the recommendation signing key must be an Ed25519 private key in PEM form');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('the recommendation signing key must be an Ed25519 private key in PEM form');
  }
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return Object.freeze({
    keyId: signerKeyIdOf(publicKeyPem),
    publicKeyPem,
    sign: (payload) => crypto.sign(null, provenanceMessage(payload), privateKey).toString('base64'),
  });
}

module.exports = { createRecommendationSigner };
