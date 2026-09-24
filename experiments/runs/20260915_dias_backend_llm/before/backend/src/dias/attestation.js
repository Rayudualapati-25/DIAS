'use strict';

/**
 * Ed25519 attestation over a DIAS recommendation submission.
 *
 * The signature binds the AI organisation's answer to the exact request it was
 * asked about: the committed verified-request hash, the committed justification
 * hash, the generation status, the model output (null on failure) and the
 * provenance the service generated. Chaincode re-derives the same payload with
 * `attestationPayload` from `lib/dias/recommendationProvenance.js` and verifies
 * it against the public key held in the active model registration, so the two
 * sides must canonicalize identically — both use the shared canonicalizer.
 *
 * A failure status is attested exactly like a successful recommendation. An
 * unsigned "the model was unavailable" claim would be an unauthenticated way to
 * push a request to the auditor, so there is no unsigned path.
 */

const crypto = require('crypto');
const fs = require('fs');
const {
  attestationPayload,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationProvenance');
const { canonicalize } = require('../../../policies/lib/bundle');

function loadPrivateKey(source) {
  if (!source) throw new Error('DIAS recommendation signing key is not configured');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(source);
  } catch (_error) {
    throw new Error('DIAS recommendation signing key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('DIAS recommendation signing key must be Ed25519');
  }
  return privateKey;
}

/**
 * Create a signer bound to one private key. The key is read once, so a missing
 * or malformed key fails at start-up rather than on the first request.
 *
 * @param {{privateKeyPem?: string, keyPath?: string, readFile?: Function}} options
 * @returns {{sign: Function, publicKeyPem: string}}
 */
function createAttestationSigner({
  privateKeyPem,
  keyPath,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) {
  const source = privateKeyPem || (keyPath ? readFile(keyPath) : null);
  const privateKey = loadPrivateKey(source);
  const publicKeyPem = crypto.createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' }).toString();

  function sign({ requestId, verifiedRequestHash, justificationHash, generationStatus, output, provenance }) {
    const payload = attestationPayload({
      requestId,
      verifiedRequestHash,
      justificationHash,
      generationStatus,
      output: output ?? null,
      provenance,
    });
    return crypto
      .sign(null, Buffer.from(canonicalize(payload), 'utf8'), privateKey)
      .toString('base64');
  }

  return Object.freeze({ sign, publicKeyPem });
}

module.exports = { createAttestationSigner };
