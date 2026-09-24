'use strict';

/**
 * Provenance and attestation for DIAS recommendations.
 *
 * The AI service generates provenance (model, prompt, policy bundle, hashes,
 * timings). Chaincode checks that it is complete and bound to this request's
 * committed facts, the registered model, and the active policy bundle, and that
 * the registered signer attested to it. It never judges whether a recommendation
 * is correct.
 */

const crypto = require('crypto');
const { SHA256_HEX, canonicalize } = require('../util/validate');
const { GENERATION_STATUS, RESPONSE_SCHEMA_VERSION } = require('./recommendationSchema');

const PROVENANCE_SCHEMA_VERSION = 'dias-recommendation-provenance-v1';
const MAX_PROVENANCE_BYTES = 8192;
const MAX_LATENCY_MS = 600000;

const MODEL_FIELDS = Object.freeze([
  'modelId', 'modelFamily', 'baseModel', 'baseModelRevision', 'quantization',
  'adapterId', 'adapterHash', 'promptVersion',
]);
const REQUIRED_STRINGS = Object.freeze([
  'schemaVersion', 'requestId', 'modelId', 'modelFamily', 'baseModel', 'baseModelRevision',
  'quantization', 'servedModel', 'promptVersion', 'responseSchemaVersion',
  'verifiedRequestHash', 'justificationHash', 'inferenceStartedAtUtc',
  'inferenceCompletedAtUtc', 'generationStatus',
]);
const POLICY_FIELDS = Object.freeze(['policyBundleId', 'policyBundleVersion', 'policyBundleHash']);

function latencyProblems(latencyMs) {
  if (!latencyMs || typeof latencyMs !== 'object' || Array.isArray(latencyMs)) {
    return ['provenance.latencyMs must be an object'];
  }
  return Object.entries(latencyMs)
    .filter(([, value]) => !Number.isFinite(value) || value < 0 || value > MAX_LATENCY_MS)
    .map(([key]) => `provenance.latencyMs.${key} is out of range`);
}

function policyProblems(provenance, policyBundle, required) {
  const present = POLICY_FIELDS.filter((field) => provenance[field] !== undefined);
  if (!required && present.length === 0) return [];
  const expected = {
    policyBundleId: policyBundle.bundleId,
    policyBundleVersion: policyBundle.version,
    policyBundleHash: policyBundle.bundleHash,
  };
  return POLICY_FIELDS
    .filter((field) => provenance[field] !== expected[field])
    .map((field) => `provenance.${field} does not match the active policy bundle`);
}

/**
 * Problems with submitted provenance; empty means valid.
 * @param {object} expected { requestId, verifiedRequestHash, justificationHash,
 *   generationStatus, model (active registration), policyBundle (active bundle) }
 */
function validateProvenance(provenance, expected) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return ['provenance must be an object'];
  }
  if (Buffer.byteLength(canonicalize(provenance), 'utf8') > MAX_PROVENANCE_BYTES) {
    return ['provenance exceeds the size limit'];
  }
  const problems = REQUIRED_STRINGS
    .filter((field) => typeof provenance[field] !== 'string' || provenance[field].length === 0)
    .map((field) => `provenance.${field} is required`);
  if (provenance.schemaVersion !== PROVENANCE_SCHEMA_VERSION) problems.push('provenance.schemaVersion is not supported');
  if (provenance.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION) problems.push('provenance.responseSchemaVersion is not supported');
  if (provenance.requestId !== expected.requestId) problems.push('provenance.requestId does not match the request');
  if (provenance.verifiedRequestHash !== expected.verifiedRequestHash) {
    problems.push('provenance.verifiedRequestHash does not match the committed verified request');
  }
  if (provenance.justificationHash !== expected.justificationHash) {
    problems.push('provenance.justificationHash does not match the committed justification');
  }
  if (provenance.generationStatus !== expected.generationStatus) {
    problems.push('provenance.generationStatus does not match the submission');
  }
  for (const field of MODEL_FIELDS) {
    if ((provenance[field] ?? null) !== (expected.model[field] ?? null)) {
      problems.push(`provenance.${field} does not match the registered model`);
    }
  }
  const ok = expected.generationStatus === GENERATION_STATUS.OK;
  problems.push(...policyProblems(provenance, expected.policyBundle, ok));
  if (ok) {
    for (const field of ['policyContextHash', 'promptHash', 'rawOutputHash']) {
      if (!SHA256_HEX.test(provenance[field] || '')) problems.push(`provenance.${field} must be a SHA-256 hash`);
    }
  }
  if (provenance.errorDetail !== undefined
      && (typeof provenance.errorDetail !== 'string' || provenance.errorDetail.length > 300)) {
    problems.push('provenance.errorDetail must be a string of at most 300 characters');
  }
  return [...problems, ...latencyProblems(provenance.latencyMs)];
}

function attestationPayload({ requestId, verifiedRequestHash, justificationHash, generationStatus, output, provenance }) {
  return { requestId, verifiedRequestHash, justificationHash, generationStatus, output, provenance };
}

/** Verify the registered model operator's Ed25519 signature over the payload. */
function verifyAttestation(registration, payload, signature) {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw new Error('recommendation attestation signature has invalid format');
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(registration.publicKeyPem);
  } catch (_error) {
    throw new Error('registered model signer public key is invalid');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('registered model signer is not Ed25519');
  }
  const verified = crypto.verify(
    null, Buffer.from(canonicalize(payload), 'utf8'), publicKey, Buffer.from(signature, 'base64')
  );
  if (!verified) throw new Error('recommendation attestation signature verification failed');
  return true;
}

module.exports = {
  MODEL_FIELDS,
  PROVENANCE_SCHEMA_VERSION,
  attestationPayload,
  validateProvenance,
  verifyAttestation,
};
