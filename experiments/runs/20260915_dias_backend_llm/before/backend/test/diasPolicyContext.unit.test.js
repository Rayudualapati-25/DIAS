'use strict';

const { expect } = require('chai');
const { loadBundle } = require('../../policies/lib/bundle');
const {
  PolicyContextUnavailableError, createPolicyContextProvider,
} = require('../src/dias/policyContextProvider');
const { verifiedRequestFixture } = require('./fixtures/diasFixtures');

describe('DIAS policy context provider', () => {
  const provider = createPolicyContextProvider();
  const { bundle, bundleHash } = loadBundle();

  it('supplies the complete bundle and narrows RBAC to the requester role', () => {
    const context = provider.assemble(verifiedRequestFixture());
    expect(context.selection).to.equal('complete-applicable-bundle');
    expect(context.bundleHash).to.equal(bundleHash);
    expect(context.clauses.map((clause) => clause.ref)).to.have.length(bundle.clauses.length);
    expect(context.requesterRole).to.deep.equal({
      role: 'inspector', organization: 'police', permissions: bundle.rbac.inspector,
    });
    expect(context).to.not.have.property('rbac');
  });

  it('marks an undefined role instead of inventing permissions', () => {
    const context = provider.assemble(verifiedRequestFixture({ requester: { role: 'auditor' } }));
    expect(context.requesterRole).to.deep.equal({ role: 'auditor', organization: null, permissions: {} });
  });

  it('hashes the context deterministically and per role', () => {
    const first = provider.assemble(verifiedRequestFixture());
    const again = provider.assemble(verifiedRequestFixture());
    const other = provider.assemble(verifiedRequestFixture({ requester: { role: 'constable' } }));
    expect(first.contextHash).to.equal(again.contextHash);
    expect(first.contextHash).to.not.equal(other.contextHash);
  });

  it('reports POLICY_CONTEXT_UNAVAILABLE when the bundle cannot be loaded', () => {
    const broken = createPolicyContextProvider({
      loader: () => { throw new Error('bundle missing'); },
    });
    let caught;
    try {
      broken.assemble(verifiedRequestFixture());
    } catch (error) {
      caught = error;
    }
    expect(caught).to.be.instanceOf(PolicyContextUnavailableError);
    expect(caught.generationStatus).to.equal('POLICY_CONTEXT_UNAVAILABLE');
  });

  it('exposes the registered bundle vocabulary needed for schema validation', () => {
    const info = provider.bundleInfo();
    expect(info.clauseRefs).to.include('GP-JURIS:C1@v1');
    expect(info.reasonCodes.SEALED_RECORD).to.equal('DENY');
    expect(info.reviewFlags).to.include('INSTRUCTION_IN_JUSTIFICATION');
  });
});
