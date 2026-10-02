'use strict';

/**
 * The pre-review recommendation commitment κ and its signed provenance
 * (docs/design/dias-v3-ledger-schema.md §6).
 *
 * κ binds one recommendation outcome — value, specific generation status, model
 * version and the digest h_M of the complete off-chain recommendation object —
 * to the request it answers: its verified-context digest, claims digest,
 * justification digest and policy. The recommendation service signs exactly
 * those fields together with the request identifier and the channel (Ed25519),
 * so a commitment cannot be altered, invented by a party without the registered
 * key, or replayed onto another request, policy or network.
 *
 * Nothing here runs, prompts, parses or scores a model. The contract checks form,
 * binding and signature; whether a recommendation is right is the auditor's call.
 */

const crypto = require('crypto');
const { assertDigest, canonicalJson } = require('./commitments');
const { SAFE_ID } = require('../util/validate');

const COMMITMENT_KEY = 'diasRecommendationCommitment';
const SIGNER_KEY = 'diasRecommendationSigner';
const COMMITMENT_SCHEMA_VERSION = 'dias-recommendation-commitment-v1';
const PROVENANCE_SCHEMA_VERSION = 'dias-recommendation-provenance-v1';
const SIGNER_SCHEMA_VERSION = 'dias-recommendation-signer-v1';
const PROVENANCE_DOMAIN = 'DIAS/v3/recommendation-provenance';

const GENERATION_STATUSES = Object.freeze([
  'OK', 'UNAVAILABLE', 'INVALID_OUTPUT', 'POLICY_CONTEXT_UNAVAILABLE', 'CONTEXT_OVERFLOW',
]);
const RECOMMENDATIONS = Object.freeze(['ALLOW', 'DENY']);
const SIGNED_FIELDS = Object.freeze([
  'contextHash', 'claimsHash', 'justificationHash', 'policyVersion', 'policyHash',
  'recommendation', 'generationStatus', 'modelVersion', 'recommendationHash', 'signerKeyId',
]);
const INPUT_FIELDS = Object.freeze([...SIGNED_FIELDS, 'signature']);
const DIGEST_FIELDS = Object.freeze([
  'contextHash', 'claimsHash', 'justificationHash', 'policyHash', 'recommendationHash', 'signerKeyId',
]);
const MODEL_VERSION = /^[A-Za-z0-9._:@+/-]{1,256}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** The validated commitment fields; throws on anything malformed or inconsistent. */
function parseCommitmentInput(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (_error) {
    throw new Error('recommendation commitment must be valid JSON');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== [...INPUT_FIELDS].sort().join(',')) {
    throw new Error(`recommendation commitment must contain exactly ${INPUT_FIELDS.join(', ')}`);
  }
  for (const field of DIGEST_FIELDS) assertDigest(input[field], field);
  if (typeof input.policyVersion !== 'string' || !SAFE_ID.test(input.policyVersion)) {
    throw new Error('policyVersion has invalid format');
  }
  if (!GENERATION_STATUSES.includes(input.generationStatus)) {
    throw new Error(`generationStatus must be one of [${GENERATION_STATUSES.join(', ')}]`);
  }
  if (input.recommendation !== null && !RECOMMENDATIONS.includes(input.recommendation)) {
    throw new Error('recommendation must be ALLOW, DENY or null');
  }
  if (input.generationStatus === 'OK' && input.recommendation === null) {
    throw new Error('generationStatus OK requires a recommendation');
  }
  if (input.generationStatus !== 'OK' && input.recommendation !== null) {
    throw new Error('only an OK generation carries a recommendation');
  }
  if (typeof input.modelVersion !== 'string' || !MODEL_VERSION.test(input.modelVersion)) {
    throw new Error('modelVersion has invalid format');
  }
  if (typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) {
    throw new Error('signature must be a base64-encoded Ed25519 signature');
  }
  return Object.fromEntries(INPUT_FIELDS.map((field) => [field, input[field]]));
}

/** The first commitment field that does not match the committed request, or null. */
function bindingMismatch(input, request) {
  const expected = [
    ['contextHash', request.verifiedRequestHash],
    ['claimsHash', request.requesterClaimsHash],
    ['justificationHash', request.justificationHash],
    ['policyVersion', request.policyVersion],
    ['policyHash', request.policyHash],
  ];
  const found = expected.find(([field, value]) => input[field] !== value);
  return found ? found[0] : null;
}

const sameCommitment = (stored, input) => INPUT_FIELDS.every((field) => stored[field] === input[field]);

/** The object the recommendation service signs. */
function provenancePayload({ channel, requestId, ...fields }) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    channel,
    requestId,
    ...Object.fromEntries(SIGNED_FIELDS.map((field) => [field, fields[field]])),
  };
}

/** The signed bytes: a domain label, a zero byte, then the canonical payload. */
function provenanceMessage(payload) {
  return Buffer.concat([
    Buffer.from(`${PROVENANCE_DOMAIN}\u0000`, 'utf8'),
    Buffer.from(canonicalJson(payload), 'utf8'),
  ]);
}

function ed25519PublicKey(publicKeyPem) {
  let key;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch (_error) {
    throw new Error('publicKeyPem must be an Ed25519 public key in PEM form');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('publicKeyPem must be an Ed25519 public key in PEM form');
  }
  return key;
}

/** keyId: SHA-256 of the DER-encoded public key. */
function signerKeyIdOf(publicKeyPem) {
  const der = ed25519PublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function normalizedPublicKeyPem(publicKeyPem) {
  return ed25519PublicKey(publicKeyPem).export({ type: 'spki', format: 'pem' });
}

function verifyProvenance({ publicKeyPem, payload, signature }) {
  try {
    return crypto.verify(null, provenanceMessage(payload), crypto.createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64'));
  } catch (_error) {
    return false;
  }
}

/**
 * What a decision is compared with: the committed value when the generation
 * succeeded, otherwise UNAVAILABLE with the specific status (or NOT_COMMITTED
 * when no commitment exists at all).
 */
function recommendationOf(commitment) {
  if (!commitment) {
    return {
      llmRecommendation: 'UNAVAILABLE', generationStatus: 'NOT_COMMITTED',
      recommendationCommitmentId: null, recommendationHash: null,
    };
  }
  return {
    llmRecommendation: commitment.generationStatus === 'OK' ? commitment.recommendation : 'UNAVAILABLE',
    generationStatus: commitment.generationStatus,
    recommendationCommitmentId: commitment.commitmentId,
    recommendationHash: commitment.recommendationHash,
  };
}

module.exports = {
  COMMITMENT_KEY,
  COMMITMENT_SCHEMA_VERSION,
  GENERATION_STATUSES,
  INPUT_FIELDS,
  PROVENANCE_DOMAIN,
  PROVENANCE_SCHEMA_VERSION,
  SIGNED_FIELDS,
  SIGNER_KEY,
  SIGNER_SCHEMA_VERSION,
  bindingMismatch,
  normalizedPublicKeyPem,
  parseCommitmentInput,
  provenanceMessage,
  provenancePayload,
  recommendationOf,
  sameCommitment,
  signerKeyIdOf,
  verifyProvenance,
};
