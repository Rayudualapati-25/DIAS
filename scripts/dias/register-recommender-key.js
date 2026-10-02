#!/usr/bin/env node
'use strict';

/**
 * Register the recommendation service's public key on the ledger (design §6.1).
 *
 *   node scripts/dias/register-recommender-key.js [--key FILE] [--registrar audit:sp.north]
 *
 * Needs an active AuditMSP district head. Safe to run again. Writes to the
 * ledger of the network the backend configuration points at.
 */

const fs = require('fs');
const path = require('path');
const fabric = require('../../backend/src/fabric/gateway');
const { DIAS_RECOMMENDER_SIGNING_KEY_FILE } = require('../../backend/src/config');
const { createRecommendationSigner } = require('../../backend/src/dias/recommendationSigner');
const { registerRecommenderKey } = require('../../backend/src/dias/signerRegistration');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
  const keyFile = path.resolve(option('key', DIAS_RECOMMENDER_SIGNING_KEY_FILE));
  const signer = createRecommendationSigner({ privateKeyPem: fs.readFileSync(keyFile, 'utf8') });
  const [org, fabricUser] = option('registrar', 'audit:sp.north').split(':');
  const result = await registerRecommenderKey({ ledger: fabric, registrar: { org, fabricUser }, signer });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`register-recommender-key failed: ${error.message}\n`);
  process.exit(1);
});
