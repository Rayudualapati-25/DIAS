'use strict';

/**
 * The recommendation service's key on the ledger (design §6.1): generate an
 * Ed25519 key, and register its public key through an AuditMSP district head.
 * Registration is safe to repeat; a revoked key is never registered again — a
 * rotation generates a new key.
 */

const crypto = require('crypto');

function generateSigningKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

async function registerRecommenderKey({ ledger, registrar, signer, label = 'dias-recommendation-service' }) {
  const signers = await ledger.evaluate(
    registrar.org, registrar.fabricUser, 'GovernanceContract', 'QueryRecommendationSigners');
  const existing = (signers || []).find((item) => item.keyId === signer.keyId);
  if (existing && existing.status === 'active') return { keyId: signer.keyId, registered: false };
  if (existing) throw new Error(`recommendation signer '${signer.keyId}' was revoked; generate a new key`);
  await ledger.submit(registrar.org, registrar.fabricUser, 'GovernanceContract', 'RegisterRecommendationSigner',
    signer.publicKeyPem, label);
  return { keyId: signer.keyId, registered: true };
}

module.exports = { generateSigningKeyPem, registerRecommenderKey };
