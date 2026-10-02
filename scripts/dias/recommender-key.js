#!/usr/bin/env node
'use strict';

/**
 * Generate the recommendation service's Ed25519 signing key (design §6.1).
 *
 *   node scripts/dias/recommender-key.js [--out FILE] [--force]
 *
 * Writes the private key with mode 0600 to DIAS_RECOMMENDER_SIGNING_KEY_FILE
 * (default backend/data/dias-recommender-signing-key.pem; *.pem files are never
 * committed) and prints the public key and its key identifier. Register the
 * public key with scripts/dias/register-recommender-key.js.
 */

const fs = require('fs');
const path = require('path');
const { DIAS_RECOMMENDER_SIGNING_KEY_FILE } = require('../../backend/src/config');
const { generateSigningKeyPem } = require('../../backend/src/dias/signerRegistration');
const { createRecommendationSigner } = require('../../backend/src/dias/recommendationSigner');

const index = process.argv.indexOf('--out');
const out = path.resolve(index > -1 ? process.argv[index + 1] : DIAS_RECOMMENDER_SIGNING_KEY_FILE);
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  process.stderr.write(`${out} exists; pass --force to replace it (the old key must then be revoked)\n`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
const pem = generateSigningKeyPem();
fs.writeFileSync(out, pem, { mode: 0o600 });
const signer = createRecommendationSigner({ privateKeyPem: pem });
process.stdout.write(`private key: ${out}\nkey id: ${signer.keyId}\n${signer.publicKeyPem}`);
