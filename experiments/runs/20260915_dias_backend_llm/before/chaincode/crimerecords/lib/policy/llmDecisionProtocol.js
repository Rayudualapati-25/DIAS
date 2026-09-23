'use strict';

const crypto = require('crypto');
const { ACTIONS, POLICY_VERSION } = require('./policyV1');
const {
  canonicalize, hashObject, SHA256_HEX,
} = require('../util/validate');
const {
  MODEL_REASON_CODES,
  canonicalRequest,
  deriveEffectiveClassification,
  materializeDecision,
} = require('./controlledDecision');

// Model generations that speak this output contract. Which one is ALLOWED to attest
// decisions is a governance decision recorded on the ledger (ActivateLLMPolicyModel);
// this list only pins the protocol compatibility of each generation.
const SUPPORTED_MODEL_VERSIONS = Object.freeze([
  'qwen3-14b-seba-lora-v4',
  'qwen3-14b-seba-lora-v5',
  'qwen3-14b-seba-lora-v6',
]);
const isSupportedModelVersion = (value) => SUPPORTED_MODEL_VERSIONS.includes(value);
const DECISIONS = Object.freeze(['allow', 'deny', 'escalate']);
const REASON_DECISION = require('./reasonDecisions');
const TOP_LEVEL_KEYS = Object.freeze([
  'counterfactual', 'decision', 'decisiveAttributes', 'explanation',
  'modelVersion', 'parsedRequest', 'policyVersion', 'reasonCode',
]);
const PARSED_REQUEST_KEYS = Object.freeze([
  'action', 'caseId', 'emergencyFlag', 'purpose', 'recordId', 'recordType',
]);
const CLASSIFICATION_KEYS = Object.freeze([
  'action', 'decision', 'modelVersion', 'policyVersion', 'purpose', 'reasonCode',
]);
const INFERENCE_KEYS = Object.freeze([
  'adapterHash', 'latencyMs', 'modelClassification', 'modelVersion',
  'outputHash', 'promptHash', 'servedModel',
]);

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) {
    throw new Error(`${label}: expected exactly the documented fields`);
  }
}

function assertString(value, label, maxLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new Error(`${label}: expected a non-empty string up to ${maxLength} characters`);
  }
}

function validateModelDecision(input, trusted) {
  assertExactKeys(input, TOP_LEVEL_KEYS, 'model decision');
  if (!DECISIONS.includes(input.decision)) throw new Error('model decision: invalid decision');
  if (!(input.reasonCode in REASON_DECISION)) throw new Error('model decision: invalid reasonCode');
  if (REASON_DECISION[input.reasonCode] !== input.decision) {
    throw new Error('model decision: reasonCode is inconsistent with decision');
  }
  if (input.policyVersion !== POLICY_VERSION) {
    throw new Error('model decision: policyVersion does not match the active contract');
  }
  if (!isSupportedModelVersion(input.modelVersion)) {
    throw new Error('model decision: modelVersion is not a supported protocol generation');
  }
  if (!Array.isArray(input.decisiveAttributes) || input.decisiveAttributes.length > 16
      || input.decisiveAttributes.some(
        (attribute) => typeof attribute !== 'string' || attribute.length > 80)) {
    throw new Error('model decision: invalid decisiveAttributes');
  }
  if (input.counterfactual !== null) {
    assertString(input.counterfactual, 'model decision counterfactual', 1000);
  }
  assertString(input.explanation, 'model decision explanation', 1000);

  assertExactKeys(input.parsedRequest, PARSED_REQUEST_KEYS, 'parsed request');
  const parsed = input.parsedRequest;
  if (!ACTIONS.includes(parsed.action)) throw new Error('parsed request: invalid action');
  assertString(parsed.purpose, 'parsed request purpose', 64);
  if (parsed.recordId !== trusted.record.recordId
      || parsed.recordType !== trusted.record.recordType
      || parsed.caseId !== trusted.record.caseId) {
    throw new Error('parsed request: model changed a ledger resource attribute');
  }
  // The recorded operation and purpose must be the ones committed with the
  // request, not the ones the model read out of the request text.
  const canonical = canonicalRequest(trusted);
  if (parsed.action !== canonical.action || parsed.purpose !== canonical.purpose) {
    throw new Error('parsed request: does not match the committed operation and purpose');
  }
  if (parsed.emergencyFlag !== Boolean(trusted.requestContext.emergencyFlag)) {
    throw new Error('parsed request: model changed the trusted emergency flag');
  }
  return input;
}

function validateModelClassification(input, decision) {
  assertExactKeys(input, CLASSIFICATION_KEYS, 'model classification');
  if (!ACTIONS.includes(input.action)) throw new Error('model classification: invalid action');
  assertString(input.purpose, 'model classification purpose', 64);
  if (!DECISIONS.includes(input.decision)) {
    throw new Error('model classification: invalid decision');
  }
  if (!MODEL_REASON_CODES.includes(input.reasonCode)) {
    throw new Error('model classification: invalid reasonCode');
  }
  if (REASON_DECISION[input.reasonCode] !== input.decision) {
    throw new Error('model classification: reasonCode is inconsistent with decision');
  }
  if (input.policyVersion !== POLICY_VERSION) {
    throw new Error('model classification: policyVersion does not match the active contract');
  }
  if (!isSupportedModelVersion(input.modelVersion)
      || input.modelVersion !== decision.modelVersion) {
    throw new Error('model classification: modelVersion does not match the submitted decision');
  }
  return input;
}

function validateInference(input, decision, trusted) {
  assertExactKeys(input, INFERENCE_KEYS, 'model inference');
  if (!isSupportedModelVersion(input.modelVersion)) {
    throw new Error('model inference: modelVersion is not a supported protocol generation');
  }
  if (input.modelVersion !== decision.modelVersion) {
    throw new Error('model inference: modelVersion does not match the submitted decision');
  }
  assertString(input.servedModel, 'model inference servedModel', 200);
  for (const field of ['adapterHash', 'promptHash', 'outputHash']) {
    if (typeof input[field] !== 'string' || !SHA256_HEX.test(input[field])) {
      throw new Error(`model inference: ${field} must be a SHA-256 hash`);
    }
  }
  if (!Number.isFinite(input.latencyMs) || input.latencyMs < 0 || input.latencyMs > 600000) {
    throw new Error('model inference: invalid latencyMs');
  }
  if (input.outputHash !== hashObject(decision)) {
    throw new Error('model inference: outputHash does not match the submitted decision');
  }
  const modelClassification = validateModelClassification(input.modelClassification, decision);
  const derived = deriveEffectiveClassification(modelClassification, trusted);
  const expectedDecision = materializeDecision(derived.effective, trusted);
  if (hashObject(expectedDecision) !== hashObject(decision)) {
    throw new Error(
      'model inference: submitted decision does not match the independently derived policy result'
    );
  }
  return {
    inference: input,
    modelInputAgreement: derived.modelInputAgreement,
    modelPolicyAgreement: derived.modelPolicyAgreement,
    policyResult: derived.policyResult,
    canonical: derived.canonical,
  };
}

function attestationPayload(queryHash, contextHash, decision, inference) {
  return { queryHash, contextHash, decision, inference };
}

function verifyAttestation(modelRegistration, payload, signature) {
  if (!modelRegistration || modelRegistration.status !== 'active') {
    throw new Error('no active LLM policy model is registered');
  }
  if (modelRegistration.modelVersion !== payload.decision.modelVersion
      || modelRegistration.adapterHash !== payload.inference.adapterHash) {
    throw new Error('model inference does not match the registered model artifact');
  }
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    throw new Error('model attestation signature has invalid format');
  }
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey(modelRegistration.publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('registered model signer is not Ed25519');
    }
    verified = crypto.verify(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64')
    );
  } catch (error) {
    if (error.message === 'registered model signer is not Ed25519') throw error;
    throw new Error('registered model signer public key is invalid');
  }
  if (!verified) throw new Error('model attestation signature verification failed');
  return true;
}

module.exports = {
  SUPPORTED_MODEL_VERSIONS,
  isSupportedModelVersion,
  REASON_DECISION,
  attestationPayload,
  validateInference,
  validateModelClassification,
  validateModelDecision,
  verifyAttestation,
};
