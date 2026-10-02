'use strict';

/**
 * Governed policy versions (design §5).
 *
 * A version is registered with the digest of its canonical policy bundle and
 * becomes active only when a second, different district head activates it. The
 * previously active version is retired and never returns: rolling back means
 * registering the old content under a new version. Requests, commitments,
 * decisions, authorizations and grants carry the binding {policyVersion,
 * policyHash} of the policy active when they were produced.
 *
 * The contracts never read the policy text; they hold only its digest. The
 * backend and the recommendation service compute that digest with
 * policyHashOf(), so every component agrees on what "the active policy" is.
 */

const { DOMAINS, assertDigest, hashCanonical } = require('./commitments');
const { SAFE_ID } = require('../util/validate');

const POLICY_VERSION_KEY = 'diasPolicyVersion';
const ACTIVE_POLICY_KEY = 'diasActivePolicy';
const ACTIVE_POLICY_ID = 'current';
const POLICY_VERSION_SCHEMA_VERSION = 'dias-policy-version-v1';
const ACTIVE_POLICY_SCHEMA_VERSION = 'dias-active-policy-v1';
const POLICY_STATUS = Object.freeze({ REGISTERED: 'registered', ACTIVE: 'active', RETIRED: 'retired' });

/** Version identifier of a policy bundle, e.g. "dias-governance-policy-v1". */
const policyVersionOf = (bundle) => `${bundle.bundleId}-${bundle.version}`;

/** v3 policy digest: canonical bundle in the `policy` domain. */
const policyHashOf = (bundle) => hashCanonical(DOMAINS.POLICY, bundle);

async function readJson(ctx, key) {
  const data = await ctx.stub.getState(key);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

const versionKey = (ctx, policyVersion) => ctx.stub.createCompositeKey(POLICY_VERSION_KEY, [policyVersion]);
const activeKey = (ctx) => ctx.stub.createCompositeKey(ACTIVE_POLICY_KEY, [ACTIVE_POLICY_ID]);

function assertPolicyVersion(policyVersion) {
  if (typeof policyVersion !== 'string' || !SAFE_ID.test(policyVersion)) {
    throw new Error('policyVersion has invalid format');
  }
  return policyVersion;
}

function assertPolicyHash(policyHash) {
  return assertDigest(policyHash, 'policyHash');
}

const readPolicyVersion = (ctx, policyVersion) => readJson(ctx, versionKey(ctx, policyVersion));
const readActivePolicy = (ctx) => readJson(ctx, activeKey(ctx));

async function requireActivePolicy(ctx) {
  const active = await readActivePolicy(ctx);
  if (!active) {
    throw new Error('DIAS_NO_ACTIVE_POLICY: no governance policy version is active on this channel');
  }
  return active;
}

/** The binding stored with every policy-dependent record. */
const policyBinding = (active) => ({ policyVersion: active.policyVersion, policyHash: active.policyHash });

const isBoundTo = (record, active) => Boolean(record && active)
  && record.policyVersion === active.policyVersion && record.policyHash === active.policyHash;

module.exports = {
  ACTIVE_POLICY_ID,
  ACTIVE_POLICY_KEY,
  ACTIVE_POLICY_SCHEMA_VERSION,
  POLICY_STATUS,
  POLICY_VERSION_KEY,
  POLICY_VERSION_SCHEMA_VERSION,
  activeKey,
  assertPolicyHash,
  assertPolicyVersion,
  isBoundTo,
  policyBinding,
  policyHashOf,
  policyVersionOf,
  readActivePolicy,
  readPolicyVersion,
  requireActivePolicy,
  versionKey,
};
