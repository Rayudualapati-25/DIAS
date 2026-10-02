'use strict';

/**
 * Seeding the governed policy (plan step 8): one district head registers the
 * policy digest, a second activates it. Re-running is safe; a different digest
 * under the same version is an error, never a silent overwrite.
 */

const { expect } = require('chai');
const { registerAndActivatePolicy, policyIdentity } = require('../src/dias/policyRegistration');

const REGISTRAR = Object.freeze({ org: 'audit', fabricUser: 'sp.north' });
const ACTIVATOR = Object.freeze({ org: 'audit', fabricUser: 'cfo.north' });
const identity = policyIdentity();

function fakeLedger({ versions = [], active = null } = {}) {
  const submitted = [];
  return {
    submitted,
    evaluate: async (org, user, contract, fn) => (fn === 'QueryPolicyVersions' ? versions : active),
    submit: async (org, user, contract, fn, ...args) => { submitted.push([user, fn, ...args]); return {}; },
  };
}

describe('policy registration for seeding', () => {
  it('identifies the repository policy by version and v3 digest', () => {
    expect(identity).to.deep.equal({
      policyVersion: 'dias-governance-policy-v1',
      policyHash: '9c66ce9ec8954dd0a976db933336aa05dd45acd683abf56f8a65472a4d298c81',
      bundleId: 'dias-governance-policy',
    });
  });

  it('registers with one district head and activates with another', async () => {
    const ledger = fakeLedger();
    const result = await registerAndActivatePolicy({ ledger, registrar: REGISTRAR, activator: ACTIVATOR });
    expect(ledger.submitted).to.deep.equal([
      ['sp.north', 'RegisterPolicyVersion', identity.policyVersion, identity.policyHash, identity.bundleId],
      ['cfo.north', 'ActivatePolicyVersion', identity.policyVersion],
    ]);
    expect(result).to.deep.equal({ registered: true, activated: true, ...identity });
  });

  it('does nothing when the same policy is already active', async () => {
    const ledger = fakeLedger({
      versions: [{ ...identity, status: 'active' }], active: { ...identity },
    });
    const result = await registerAndActivatePolicy({ ledger, registrar: REGISTRAR, activator: ACTIVATOR });
    expect(ledger.submitted).to.deep.equal([]);
    expect(result).to.include({ registered: false, activated: false });
  });

  it('refuses a registered version whose digest differs, and the same person twice', async () => {
    const ledger = fakeLedger({ versions: [{ ...identity, policyHash: 'f'.repeat(64), status: 'registered' }] });
    await registerAndActivatePolicy({ ledger, registrar: REGISTRAR, activator: ACTIVATOR })
      .then(() => expect.fail('expected a refusal'), (error) => expect(error.message).to.match(/different digest/));
    await registerAndActivatePolicy({ ledger: fakeLedger(), registrar: REGISTRAR, activator: REGISTRAR })
      .then(() => expect.fail('expected a refusal'), (error) => expect(error.message).to.match(/two different district heads/));
  });
});
