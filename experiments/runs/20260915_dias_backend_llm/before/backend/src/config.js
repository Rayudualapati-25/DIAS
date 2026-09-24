'use strict';

const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const PORT = Number(process.env.PORT || 3001);
const configuredJwtSecret = process.env.JWT_SECRET;

let JWT_SECRET = configuredJwtSecret;
if (!configuredJwtSecret || configuredJwtSecret.trim().length === 0) {
  if (NODE_ENV === 'production') {
    throw new Error('[config] JWT_SECRET is required when NODE_ENV=production');
  }

  JWT_SECRET = 'dev-only-secret-change-me';
  // eslint-disable-next-line no-console
  console.warn('[config] JWT_SECRET not set — using a dev-only default. Do not deploy like this.');
}

function parseCorsOrigin(value) {
  const origin = value || `http://localhost:${PORT}`;
  if (origin === '*') {
    throw new Error('[config] CORS_ORIGIN must be an explicit http(s) origin, not "*"');
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch (_err) {
    throw new Error(`[config] CORS_ORIGIN is not a valid URL: ${origin}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error('[config] CORS_ORIGIN must be one http(s) origin without a path');
  }
  return parsed.origin;
}

const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);
const ACCESS_POLICY_MODE = process.env.ACCESS_POLICY_MODE || 'llm-only';
if (!['llm-only', 'legacy-baseline'].includes(ACCESS_POLICY_MODE)) {
  throw new Error('[config] ACCESS_POLICY_MODE must be "llm-only" or "legacy-baseline"');
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLED_LLM_ADAPTER_HASH = '5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe';
const NETWORK_DIR = path.join(REPO_ROOT, 'network');
const VAULT_DIR = process.env.AGENCY_VAULT_DIR
  ? (path.isAbsolute(process.env.AGENCY_VAULT_DIR)
    ? path.normalize(process.env.AGENCY_VAULT_DIR)
    : path.resolve(REPO_ROOT, process.env.AGENCY_VAULT_DIR))
  : path.resolve(__dirname, '..', 'data', 'agency-vault');
const LLM_POLICY_SIGNING_KEY_PATH = process.env.LLM_POLICY_SIGNING_KEY_PATH
  ? (path.isAbsolute(process.env.LLM_POLICY_SIGNING_KEY_PATH)
    ? path.normalize(process.env.LLM_POLICY_SIGNING_KEY_PATH)
    : path.resolve(REPO_ROOT, process.env.LLM_POLICY_SIGNING_KEY_PATH))
  : NODE_ENV === 'production' ? '' : path.join(REPO_ROOT, 'backend/data/llm-policy-signer-private.pem');
const LLM_POLICY_ADAPTER_PATH = process.env.LLM_POLICY_ADAPTER_PATH
  ? (path.isAbsolute(process.env.LLM_POLICY_ADAPTER_PATH)
    ? path.normalize(process.env.LLM_POLICY_ADAPTER_PATH)
    : path.resolve(REPO_ROOT, process.env.LLM_POLICY_ADAPTER_PATH))
  : path.join(
    REPO_ROOT,
    'LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best'
  );
// --- DIAS (binary ALLOW/DENY advisory recommender) ------------------------
//
// The DIAS runtime is deliberately separate from the SEAL-era settings above so
// the two can run side by side: SEAL keeps port 8080 and the v6 adapter, DIAS
// points at its own server, its own signing key and its own chaincode name.
const resolveFromRepo = (value, fallback) => {
  if (!value) return fallback;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
};

const DIAS_POLICY_BUNDLE_PATH = resolveFromRepo(
  process.env.DIAS_POLICY_BUNDLE_PATH,
  path.join(REPO_ROOT, 'policies', 'dias-governance-policy-v1.json')
);
const DIAS_SIGNING_KEY_PATH = resolveFromRepo(
  process.env.DIAS_SIGNING_KEY_PATH,
  NODE_ENV === 'production' ? '' : path.join(REPO_ROOT, 'backend/data/dias-recommendation-signer-private.pem')
);
const DIAS_ADAPTER_PATH = resolveFromRepo(process.env.DIAS_ADAPTER_PATH, '');
const DIAS_CHECKPOINT_PATH = resolveFromRepo(
  process.env.DIAS_CHECKPOINT_PATH,
  path.join(REPO_ROOT, 'backend', 'data', 'dias-recommender-checkpoint.json')
);

// The Fabric CLI binaries ship with the workspace rather than the system.
// fabric-ca-client is used to register and enrol new department users, exactly
// as scripts/seed-identities.sh does, so web-created identities are
// byte-identical to seeded ones.
const FABRIC_BIN = path.resolve(NETWORK_DIR, '..', '..', 'fabric-samples', 'bin');

// caPort/caName are what fabric-ca-client needs to register and enrol a new
// user into that department; they mirror network/compose/compose-ca.yaml.
const ORG_CONFIG = Object.freeze({
  police: {
    mspId: 'PoliceMSP',
    domain: 'police.example.com',
    peerEndpoint: 'localhost:7051',
    peerHostAlias: 'peer0.police.example.com',
    caPort: 7054,
    caName: 'ca-police',
  },
  forensics: {
    mspId: 'ForensicsMSP',
    domain: 'forensics.example.com',
    peerEndpoint: 'localhost:8051',
    peerHostAlias: 'peer0.forensics.example.com',
    caPort: 8054,
    caName: 'ca-forensics',
  },
  prosecution: {
    mspId: 'ProsecutionMSP',
    domain: 'prosecution.example.com',
    peerEndpoint: 'localhost:9051',
    peerHostAlias: 'peer0.prosecution.example.com',
    caPort: 9054,
    caName: 'ca-prosecution',
  },
  court: {
    mspId: 'CourtMSP',
    domain: 'court.example.com',
    peerEndpoint: 'localhost:10051',
    peerHostAlias: 'peer0.court.example.com',
    caPort: 10054,
    caName: 'ca-court',
  },
  audit: {
    mspId: 'AuditMSP',
    domain: 'audit.example.com',
    peerEndpoint: 'localhost:11051',
    peerHostAlias: 'peer0.audit.example.com',
    caPort: 11054,
    caName: 'ca-audit',
  },
  // The organisation that operates the policy model. Its identity signs the
  // decisions the model produces; it never raises a request of its own.
  ai: {
    mspId: 'AIOrgMSP',
    domain: 'ai.example.com',
    peerEndpoint: 'localhost:12051',
    peerHostAlias: 'peer0.ai.example.com',
    caPort: 13054,
    caName: 'ca-ai',
  },
});

module.exports = Object.freeze({
  NODE_ENV,
  PORT,
  CORS_ORIGIN,
  ACCESS_POLICY_MODE,

  // Local LLM used only to reword decisions into plain language.
  // Change OLLAMA_MODEL to any model you have pulled (e.g. llama3.1:8b).
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'llama3.2:3b',
  OLLAMA_SEED: Number(process.env.OLLAMA_SEED || 42),
  OLLAMA_TIMEOUT_MS: Number(process.env.OLLAMA_TIMEOUT_MS || 45000),

  // Fine-tuned Qwen policy model served by MLX-LM's OpenAI-compatible server.
  LLM_POLICY_URL: process.env.LLM_POLICY_URL || 'http://127.0.0.1:8080/v1',
  // MLX-LM maps this alias to the startup model together with its adapter.
  LLM_POLICY_MODEL: process.env.LLM_POLICY_MODEL || 'default_model',
  LLM_POLICY_TIMEOUT_MS: Number(process.env.LLM_POLICY_TIMEOUT_MS || 60000),
  LLM_POLICY_ADAPTER_HASH: process.env.LLM_POLICY_ADAPTER_HASH || BUNDLED_LLM_ADAPTER_HASH,
  LLM_POLICY_ADAPTER_PATH,
  LLM_POLICY_SIGNING_KEY_PATH,

  // Signing in has to read the account before it knows which department the
  // account belongs to, so that one lookup uses a fixed identity. The audit
  // organisation is the right one to hold it: oversight already reads across
  // all five departments, and UserContract.ReadUser is evaluate-only.
  AUTH_ORG: process.env.AUTH_ORG || 'audit',
  // A district head of the authority organisation. Sign-in must read a profile
  // before it knows which department the person belongs to, so that one lookup
  // uses a fixed identity; the authority organisation already reads across all
  // departments and UserContract.ReadUser is evaluate-only.
  AUTH_USER: process.env.AUTH_USER || 'sp.north',

  JWT_SECRET,
  JWT_EXPIRY: '8h',
  // The redesigned DIAS chaincode deploys under its own name so the existing
  // crimerecords deployment keeps running untouched.
  CHANNEL: process.env.CHANNEL || 'crimechannel',
  CHAINCODE: process.env.CHAINCODE || 'crimerecords',
  NETWORK_DIR,
  VAULT_DIR,
  FABRIC_BIN,
  ORG_CONFIG,

  // DIAS recommendation model endpoint. Defaults to port 8081 so a DIAS run
  // never contends with the SEAL v6 server on 8080.
  DIAS_MODEL_URL: process.env.DIAS_MODEL_URL || 'http://127.0.0.1:8081/v1',
  DIAS_MODEL_SERVED_NAME: process.env.DIAS_MODEL_SERVED_NAME || 'default_model',
  DIAS_MODEL_TIMEOUT_MS: Number(process.env.DIAS_MODEL_TIMEOUT_MS || 120000),
  DIAS_MODEL_MAX_TOKENS: Number(process.env.DIAS_MODEL_MAX_TOKENS || 512),
  DIAS_MAX_PROMPT_CHARS: Number(process.env.DIAS_MAX_PROMPT_CHARS || 24000),
  DIAS_ADAPTER_PATH,
  DIAS_POLICY_BUNDLE_PATH,
  DIAS_SIGNING_KEY_PATH,
  DIAS_CHECKPOINT_PATH,
});
