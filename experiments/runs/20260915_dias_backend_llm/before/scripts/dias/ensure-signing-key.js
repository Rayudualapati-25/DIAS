#!/usr/bin/env node
'use strict';

/**
 * Create the DIAS recommendation service's Ed25519 signing key once, then only
 * verify it. The key attests every recommendation and every generation-failure
 * status, so a new key silently replacing the old one would make every existing
 * attestation unverifiable against the active registration — hence `wx`, which
 * refuses to overwrite.
 *
 *   node scripts/dias/ensure-signing-key.js [--print-public]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DIAS_SIGNING_KEY_PATH } = require('../../backend/src/config');

function loadKey(keyPath) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${keyPath} exists but is not an Ed25519 private key`);
  }
  return privateKey;
}

function main() {
  const keyPath = path.resolve(DIAS_SIGNING_KEY_PATH);
  let privateKey;
  if (fs.existsSync(keyPath)) {
    privateKey = loadKey(keyPath);
    console.log(`verified existing Ed25519 DIAS signing key: ${keyPath}`);
  } else {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const generated = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(keyPath, generated.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    privateKey = generated.privateKey;
    console.log(`created Ed25519 DIAS signing key: ${keyPath}`);
  }
  const publicKeyPem = crypto.createPublicKey(privateKey)
    .export({ type: 'spki', format: 'pem' }).toString();
  console.log(`public key sha256: ${crypto.createHash('sha256').update(publicKeyPem).digest('hex')}`);
  if (process.argv.includes('--print-public')) process.stdout.write(publicKeyPem);
}

main();
