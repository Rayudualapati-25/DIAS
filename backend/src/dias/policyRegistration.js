'use strict';

/**
 * Register and activate the governance policy on the ledger (design §5).
 *
 * The digest is computed here from the canonical bundle; the ledger never holds
 * the policy text. Registration and activation need two different AuditMSP
 * district heads, so this takes two identities. It is safe to run again: an
 * already active policy is left alone, and a version registered under a
 * different digest is an error rather than something to overwrite.
 */

const path = require('path');
const { loadBundle } = require('../../../policies/lib/bundle');
const {
  policyHashOf, policyVersionOf,
} = require('../../../chaincode/crimerecords/lib/dias/policyRegistry');

const DEFAULT_BUNDLE = path.resolve(__dirname, '..', '..', '..', 'policies', 'dias-governance-policy-v1.json');

/** {policyVersion, policyHash, bundleId} of a policy bundle file. */
function policyIdentity(bundlePath = DEFAULT_BUNDLE) {
  const { bundle } = loadBundle(bundlePath);
  return {
    policyVersion: policyVersionOf(bundle),
    policyHash: policyHashOf(bundle),
    bundleId: bundle.bundleId,
  };
}

async function registerAndActivatePolicy({ ledger, registrar, activator, bundlePath = DEFAULT_BUNDLE }) {
  if (registrar.org === activator.org && registrar.fabricUser === activator.fabricUser) {
    throw new Error('registration and activation need two different district heads');
  }
  const identity = policyIdentity(bundlePath);
  const versions = await ledger.evaluate(
    registrar.org, registrar.fabricUser, 'GovernanceContract', 'QueryPolicyVersions');
  const existing = versions.find((item) => item.policyVersion === identity.policyVersion);
  if (existing && existing.policyHash !== identity.policyHash) {
    throw new Error(`policy version '${identity.policyVersion}' is registered with a different digest`);
  }
  let registered = false;
  if (!existing) {
    await ledger.submit(registrar.org, registrar.fabricUser, 'GovernanceContract', 'RegisterPolicyVersion',
      identity.policyVersion, identity.policyHash, identity.bundleId);
    registered = true;
  }
  const active = await ledger.evaluate(
    activator.org, activator.fabricUser, 'GovernanceContract', 'GetActivePolicy');
  let activated = false;
  if (!active || active.policyVersion !== identity.policyVersion) {
    await ledger.submit(activator.org, activator.fabricUser, 'GovernanceContract', 'ActivatePolicyVersion',
      identity.policyVersion);
    activated = true;
  }
  return { registered, activated, ...identity };
}

module.exports = { DEFAULT_BUNDLE, policyIdentity, registerAndActivatePolicy };
