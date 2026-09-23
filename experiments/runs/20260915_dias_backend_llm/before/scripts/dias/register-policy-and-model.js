#!/usr/bin/env node
'use strict';

/**
 * Register and activate the DIAS governance policy bundle and a recommendation
 * model, as an AuditMSP district head.
 *
 * Both steps are idempotent: an already-registered bundle or an already-active
 * model is reported and skipped rather than re-submitted, so this can be run
 * after every deployment without accumulating ledger writes.
 *
 * A model is registered by IDENTITY, and the identity of a fine-tuned model
 * includes the bytes of its adapter. The script therefore refuses to register or
 * activate an adapter-backed model unless it can read the adapter directory and
 * recompute the same digest, because a registration whose hash does not describe
 * any local weights cannot be checked by anyone later.
 *
 *   # untuned base, for the baseline
 *   node scripts/dias/register-policy-and-model.js \
 *     --model-id qwen3-14b-base --purpose research-baseline
 *
 *   # fine-tuned V7
 *   node scripts/dias/register-policy-and-model.js \
 *     --model-id qwen3-14b-dias-v7 --purpose fine-tuned-candidate \
 *     --adapter-id qwen3-14b-dias-lora-v7 \
 *     --adapter-path LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-dias-lora-v7
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fabric = require('../../backend/src/fabric/gateway');
const config = require('../../backend/src/config');
const { loadBundle } = require('../../policies/lib/bundle');
const { PROMPT_VERSION } = require('../../backend/src/dias/recommendationPrompt');
const {
  RESPONSE_SCHEMA_VERSION,
} = require('../../chaincode/crimerecords/lib/dias/recommendationSchema');
const { adapterDigest } = require('./adapterDigest');

const POLICY_ADMIN = Object.freeze({ org: 'audit', user: 'sp.north' });
const CONTRACT = 'PolicyContract';
const BASE_MODEL = 'mlx-community/Qwen3-14B-4bit';
const BASE_REVISION = 'a4d9b2df59d2c150bef02fcbe0d91046b7ca33a4';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function signerPublicKey() {
  const keyPath = path.resolve(config.DIAS_SIGNING_KEY_PATH);
  if (!fs.existsSync(keyPath)) {
    throw new Error(`DIAS signing key not found at ${keyPath}; run scripts/dias/ensure-signing-key.js first`);
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${keyPath} is not an Ed25519 private key`);
  }
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
}

/** Adapter identity, or an explicit "no adapter" for an untuned base model. */
function adapterIdentity(args) {
  if (!args['adapter-path'] && !args['adapter-id']) {
    return { adapterId: null, adapterHash: null, evidence: 'untuned base model, no adapter' };
  }
  if (!args['adapter-path'] || !args['adapter-id']) {
    throw new Error('--adapter-id and --adapter-path must be given together');
  }
  const dir = path.isAbsolute(args['adapter-path'])
    ? args['adapter-path']
    : path.resolve(__dirname, '..', '..', args['adapter-path']);
  const { digest, files } = adapterDigest(dir);
  if (args['expect-adapter-hash'] && args['expect-adapter-hash'] !== digest) {
    throw new Error(
      `adapter digest mismatch: ${dir} hashes to ${digest}, but ${args['expect-adapter-hash']} was expected`
    );
  }
  return {
    adapterId: args['adapter-id'],
    adapterHash: digest,
    evidence: `${dir}\n    ${files.map((f) => `${f.name} ${f.bytes}B ${f.sha256.slice(0, 16)}…`).join('\n    ')}`,
  };
}

async function ensureBundle(bundlePath) {
  const { bundle, bundleHash } = loadBundle(bundlePath);
  const active = await fabric.evaluate(
    POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT, 'GetActiveGovernancePolicyBundle');
  if (active && active.bundleHash === bundleHash) {
    console.log(`policy bundle already active: ${active.bundleId} ${active.version} ${bundleHash}`);
    return active;
  }
  try {
    await fabric.submit(POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT,
      'RegisterGovernancePolicyBundle', JSON.stringify(bundle));
    console.log(`registered policy bundle ${bundle.bundleId} ${bundle.version}`);
  } catch (error) {
    if (!/already registered/.test(error.message)) throw error;
    console.log(`policy bundle ${bundle.bundleId} ${bundle.version} was already registered`);
  }
  // A bundle registered earlier under the same id/version but different content
  // would have a different hash; the chaincode recomputes it, so verify.
  const registered = await fabric.evaluate(POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT,
    'GetGovernancePolicyBundle', bundle.bundleId, bundle.version);
  if (registered.bundleHash !== bundleHash) {
    throw new Error(
      `ledger holds a different ${bundle.bundleId} ${bundle.version}: ${registered.bundleHash} `
      + `on chain, ${bundleHash} locally. Publish a new version rather than editing a frozen one.`
    );
  }
  const activated = await fabric.submit(POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT,
    'ActivateGovernancePolicyBundle', bundle.bundleId, bundle.version);
  console.log(`activated policy bundle ${bundle.bundleId} ${bundle.version} ${bundleHash}`);
  return activated;
}

async function ensureModel(registration, publicKeyPem) {
  const active = await fabric.evaluate(
    POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT, 'GetActiveRecommendationModel');
  const sameIdentity = active
    && active.modelId === registration.modelId
    && (active.adapterHash || null) === registration.adapterHash
    && active.promptVersion === registration.promptVersion
    && active.responseSchemaVersion === registration.responseSchemaVersion
    && active.publicKeyHash === crypto.createHash('sha256').update(publicKeyPem).digest('hex');
  if (sameIdentity) {
    console.log(`model already active: ${active.registrationId} ${active.modelId}`);
    return active;
  }
  const existing = await fabric.evaluate(
    POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT, 'QueryRecommendationModels');
  const match = existing.find((item) => item.modelId === registration.modelId
    && (item.adapterHash || null) === registration.adapterHash
    && item.promptVersion === registration.promptVersion
    && item.responseSchemaVersion === registration.responseSchemaVersion
    && item.publicKeyHash === crypto.createHash('sha256').update(publicKeyPem).digest('hex'));
  const registered = match || await fabric.submit(
    POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT, 'RegisterRecommendationModel',
    JSON.stringify(registration), publicKeyPem);
  console.log(match
    ? `reusing registration ${registered.registrationId}`
    : `registered model ${registered.registrationId} ${registered.modelId}`);
  const activated = await fabric.submit(POLICY_ADMIN.org, POLICY_ADMIN.user, CONTRACT,
    'ActivateRecommendationModel', registered.registrationId);
  console.log(`activated model ${activated.registrationId} ${activated.modelId}`
    + ` (previous: ${activated.previousRegistrationId || 'none'})`);
  return activated;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const modelId = args['model-id'];
  const purpose = args.purpose || 'research-baseline';
  if (!modelId) throw new Error('--model-id is required');

  const adapter = adapterIdentity(args);
  console.log(`adapter: ${adapter.evidence}`);
  const publicKeyPem = signerPublicKey();

  await ensureBundle(args.bundle || config.DIAS_POLICY_BUNDLE_PATH);

  const registration = {
    modelId,
    modelFamily: args['model-family'] || 'qwen3',
    baseModel: args['base-model'] || BASE_MODEL,
    baseModelRevision: args['base-revision'] || BASE_REVISION,
    quantization: args.quantization || '4bit',
    adapterId: adapter.adapterId,
    adapterHash: adapter.adapterHash,
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    registrationPurpose: purpose,
  };
  await ensureModel(registration, publicKeyPem);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(`[dias-register] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { adapterIdentity, ensureBundle, ensureModel, parseArgs, signerPublicKey };
