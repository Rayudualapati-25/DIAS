'use strict';

/**
 * The recommendation service's signing key (design §6.1).
 *
 * Ed25519, loaded from the service's own environment. The public key and its
 * identifier (SHA-256 of the DER public key) are what a district head registers
 * on the ledger; the private key never leaves the service. When the service runs
 * as its own process (step 12) the backend never holds this key.
 */

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
