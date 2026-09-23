'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { LLM_POLICY_SIGNING_KEY_PATH } = require('../config');

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildAttestationPayload({ queryHash, contextHash, decision, inference }) {
  return { queryHash, contextHash, decision, inference };
}

function signAttestation(input, options = {}) {
  const keySource = options.privateKeyPem
    || (LLM_POLICY_SIGNING_KEY_PATH
      ? fs.readFileSync(LLM_POLICY_SIGNING_KEY_PATH, 'utf8') : null);
  if (!keySource) throw new Error('LLM policy signing key is not configured');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(keySource);
  } catch (_error) {
    throw new Error('LLM policy signing key is invalid');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('LLM policy signing key must be Ed25519');
  }
  const payload = buildAttestationPayload(input);
  return crypto.sign(
    null,
    Buffer.from(canonicalize(payload), 'utf8'),
    privateKey
  ).toString('base64');
}

module.exports = { buildAttestationPayload, canonicalize, signAttestation };
