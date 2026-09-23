#!/usr/bin/env node
'use strict';

/** Create the local AI operator's Ed25519 signing key once, then only verify it. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const keyPath = path.resolve(
  process.env.LLM_POLICY_SIGNING_KEY_PATH
    || 'backend/data/llm-policy-signer-private.pem'
);

function verifyExistingKey() {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${keyPath} exists but is not an Ed25519 private key`);
  }
  console.log(`verified existing Ed25519 AI signing key: ${keyPath}`);
}

if (fs.existsSync(keyPath)) {
  verifyExistingKey();
} else {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(keyPath, pem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(`created Ed25519 AI signing key: ${keyPath}`);
}
