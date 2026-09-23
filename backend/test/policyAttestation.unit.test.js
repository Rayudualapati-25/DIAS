'use strict';

const crypto = require('crypto');
const { expect } = require('chai');
const {
  buildAttestationPayload,
  canonicalize,
  signAttestation,
} = require('../src/llm/policyAttestation');

describe('policy model attestation', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const input = {
    queryHash: 'a'.repeat(64),
    contextHash: 'b'.repeat(64),
    decision: { decision: 'deny', reasonCode: 'NOT_ASSIGNED' },
    inference: { adapterHash: 'c'.repeat(64), outputHash: 'd'.repeat(64) },
  };

  it('creates a verifiable Ed25519 signature over the complete decision binding', () => {
    const signature = signAttestation(input, { privateKeyPem });
    const payload = buildAttestationPayload(input);
    expect(crypto.verify(
      null,
      Buffer.from(canonicalize(payload), 'utf8'),
      keys.publicKey,
      Buffer.from(signature, 'base64')
    )).to.equal(true);
  });

  it('fails verification after any trusted context value changes', () => {
    const signature = signAttestation(input, { privateKeyPem });
    const changed = buildAttestationPayload({ ...input, contextHash: 'e'.repeat(64) });
    expect(crypto.verify(
      null,
      Buffer.from(canonicalize(changed), 'utf8'),
      keys.publicKey,
      Buffer.from(signature, 'base64')
    )).to.equal(false);
  });

  const structuredInput = {
    ...input,
    decision: {
      decision: 'deny',
      reasonCode: 'INSUFFICIENT_CLEARANCE',
      parsedRequest: {
        action: 'view', purpose: 'investigation', recordId: 'FIR-1',
        recordType: 'fir', caseId: 'CASE-1', emergencyFlag: false,
      },
      decisiveAttributes: ['subject.clearance', 'object.sensitivityLevel'],
      counterfactual: "access would satisfy the clearance condition if requester clearance were 'high' or higher",
      explanation: 'Access is denied because the authenticated clearance is below the record sensitivity.',
      policyVersion: 'crime-policy-v2',
      modelVersion: 'qwen3-14b-seba-lora-v6',
    },
  };

  const coveredFields = {
    'effective decision': (decision) => ({ ...decision, decision: 'allow' }),
    reasonCode: (decision) => ({ ...decision, reasonCode: 'POLICY_SATISFIED' }),
    'explanation text': (decision) => ({ ...decision, explanation: 'Tampered text.' }),
    decisiveAttributes: (decision) => ({ ...decision, decisiveAttributes: ['subject.role'] }),
    counterfactual: (decision) => ({ ...decision, counterfactual: 'Contact an administrator.' }),
  };

  Object.entries(coveredFields).forEach(([field, tamper]) => {
    it(`cryptographically binds the ${field}`, () => {
      const signature = signAttestation(structuredInput, { privateKeyPem });
      const changed = buildAttestationPayload({
        ...structuredInput,
        decision: tamper(structuredInput.decision),
      });
      expect(crypto.verify(
        null,
        Buffer.from(canonicalize(changed), 'utf8'),
        keys.publicKey,
        Buffer.from(signature, 'base64')
      )).to.equal(false);
    });
  });

  it('rejects a non-Ed25519 signing key', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signAttestation(input, { privateKeyPem: rsaPem }))
      .to.throw(/must be Ed25519/);
  });
});
