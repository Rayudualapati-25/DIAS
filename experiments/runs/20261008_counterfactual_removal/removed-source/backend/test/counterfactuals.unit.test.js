'use strict';

/**
 * Counterfactual explanations (plan step 14, design §13).
 *
 * For a request the written policy refuses, the generator lists the smallest
 * changes of fact after which the written policy would allow it. Every change
 * set it returns is applied to the facts and checked with the reference policy
 * oracle; nothing unverified is kept. A counterfactual explains. It is never
 * compared with the LLM recommendation, decides nothing and grants nothing.
 */

const { expect } = require('chai');
const { loadBundle } = require('../../policies/lib/bundle');
const { evaluateReference } = require('../../policies/reference-oracle/referencePolicyOracle');
const {
  AUTHORITY, COUNTERFACTUAL_SCHEMA_VERSION, MAX_CHANGES, applyChanges, counterfactualsFor,
} = require('../src/dias/counterfactuals');
const { verifiedRequestFixture } = require('./fixtures/diasFixtures');

const { bundle } = loadBundle();
const explain = (overrides) => counterfactualsFor({ verifiedRequest: verifiedRequestFixture(overrides), bundle });
const facts = (set) => set.changes.map((change) => change.fact);
const resultAfter = (overrides, set) => evaluateReference(
  bundle, applyChanges(verifiedRequestFixture(overrides), set.changes)
).recommendation;

/** Requests the written policy refuses, each for a different reason. */
const REFUSED = Object.freeze({
  notAssigned: { requester: { assignedToRequestedCase: false } },
  lowClearance: { requester: { clearance: 'low' } },
  sealed: { resource: { sealed: true } },
  juvenile: { resource: { juvenileFlag: true } },
  revoked: { requester: { credentialStatus: 'revoked' } },
  exportNotPermitted: { resource: { recordType: 'evidence' }, request: { action: 'export' } },
  sealedAndNotAssigned: { requester: { assignedToRequestedCase: false }, resource: { sealed: true } },
  otherDistrict: { requester: { jurisdiction: 'district-south' } },
  threeReasons: {
    requester: { assignedToRequestedCase: false, clearance: 'low' }, resource: { sealed: true, sensitivityLevel: 'high' },
  },
});

describe('counterfactual explanations', () => {
  it('has nothing to change when the written policy already allows the request', () => {
    expect(explain()).to.deep.equal({
      schemaVersion: COUNTERFACTUAL_SCHEMA_VERSION,
      writtenPolicy: { result: 'ALLOW', blockingClauses: [] },
      changeSets: [],
      unresolvedClauses: [],
      maxChanges: MAX_CHANGES,
    });
  });

  it('names the one change that would let the written policy allow the request, and who can make it', () => {
    const result = explain(REFUSED.notAssigned);
    expect(result.writtenPolicy).to.deep.equal({ result: 'DENY', blockingClauses: ['GP-ASSIGN:C1@v1'] });
    expect(result.changeSets).to.deep.equal([{
      changes: [{
        fact: 'requester.assignedToRequestedCase', from: false, to: true, authority: AUTHORITY.ADMINISTRATIVE,
        description: 'the officer is assigned to the requested case',
      }],
      writtenPolicyResultAfter: 'ALLOW',
    }]);
    expect(result.unresolvedClauses).to.deep.equal([]);
  });

  it('labels each kind of change with the authority that could make it', () => {
    const only = (overrides) => explain(overrides).changeSets.map((set) => set.changes[0]);
    expect(only(REFUSED.sealed)).to.deep.equal([{
      fact: 'resource.sealed', from: true, to: false, authority: AUTHORITY.LEGAL, description: 'the court unseals the record',
    }]);
    expect(only(REFUSED.juvenile)[0]).to.include({ fact: 'resource.juvenileFlag', authority: AUTHORITY.LEGAL });
    expect(only(REFUSED.revoked)[0]).to.include({
      fact: 'requester.credentialStatus', from: 'revoked', to: 'active', authority: AUTHORITY.ADMINISTRATIVE,
    });
    const requesterChanges = only(REFUSED.exportNotPermitted).filter((change) => change.authority === AUTHORITY.REQUESTER);
    expect(requesterChanges.map((change) => `${change.fact}=${change.to}`)).to.include('request.action=view');
  });

  it('offers the smallest sufficient step for a graded fact, in either direction', () => {
    const steps = explain(REFUSED.lowClearance).changeSets.map((set) => set.changes[0]);
    // The record is of medium sensitivity: medium clearance is enough, and so is reclassifying to low.
    expect(steps.map((change) => `${change.fact}:${change.from}->${change.to}`)).to.have.members([
      'requester.clearance:low->medium', 'resource.sensitivityLevel:medium->low',
    ]);
    expect(steps.every((change) => change.authority === AUTHORITY.ADMINISTRATIVE)).to.equal(true);
  });

  it('pairs two changes only when neither is enough alone', () => {
    const result = explain(REFUSED.sealedAndNotAssigned);
    expect(result.writtenPolicy.blockingClauses).to.deep.equal(['GP-SEAL:C1@v1', 'GP-ASSIGN:C1@v1']);
    expect(result.changeSets.map(facts)).to.deep.equal([['requester.assignedToRequestedCase', 'resource.sealed']]);
    // A fact that is enough alone never appears in a pair as well.
    const single = explain(REFUSED.notAssigned).changeSets;
    expect(single.every((set) => set.changes.length === 1)).to.equal(true);
  });

  it('says so when no permitted change would help', () => {
    const result = explain(REFUSED.otherDistrict);
    expect(result.writtenPolicy).to.deep.equal({ result: 'DENY', blockingClauses: ['GP-JURIS:C1@v1'] });
    expect(result.changeSets).to.deep.equal([]);
    // A posting to another district is not a change this system proposes.
    expect(result.unresolvedClauses).to.deep.equal(['GP-JURIS:C1@v1']);
  });

  it('proposes nothing when more than two facts would have to change', () => {
    const result = explain(REFUSED.threeReasons);
    expect(result.changeSets).to.deep.equal([]);
    expect(result.unresolvedClauses).to.deep.equal(result.writtenPolicy.blockingClauses);
    expect(result.maxChanges).to.equal(2);
  });

  it('keeps only change sets that the reference policy confirms, for every refused case', () => {
    for (const [name, overrides] of Object.entries(REFUSED)) {
      const result = explain(overrides);
      expect(result.writtenPolicy.result, name).to.equal('DENY');
      for (const set of result.changeSets) {
        expect(set.changes.length, name).to.be.within(1, MAX_CHANGES);
        expect(resultAfter(overrides, set), `${name}: ${JSON.stringify(facts(set))}`).to.equal('ALLOW');
        expect(set.writtenPolicyResultAfter).to.equal('ALLOW');
      }
    }
  });

  it('is minimal: no kept change set stays sufficient with one of its changes removed', () => {
    for (const [name, overrides] of Object.entries(REFUSED)) {
      for (const set of explain(overrides).changeSets.filter((item) => item.changes.length > 1)) {
        for (const change of set.changes) {
          const rest = { changes: set.changes.filter((item) => item !== change) };
          expect(resultAfter(overrides, rest), `${name} without ${change.fact}`).to.equal('DENY');
        }
      }
    }
  });

  it('never names anything as a decision, a recommendation or a grant', () => {
    const keys = (value) => (value && typeof value === 'object'
      ? [...(Array.isArray(value) ? [] : Object.keys(value)), ...Object.values(value).flatMap(keys)] : []);
    for (const overrides of [undefined, ...Object.values(REFUSED)]) {
      expect(keys(explain(overrides)).filter((key) => /decision|recommend|grant|outcome|allow|deny/i.test(key)))
        .to.deep.equal([]);
    }
  });

  it('does not change the facts it was given', () => {
    const original = verifiedRequestFixture(REFUSED.sealedAndNotAssigned);
    const before = JSON.stringify(original);
    counterfactualsFor({ verifiedRequest: original, bundle });
    const changed = applyChanges(original, [{ fact: 'resource.sealed', to: false }]);
    expect(JSON.stringify(original)).to.equal(before);
    expect(changed.resource.sealed).to.equal(false);
    expect(() => applyChanges(original, [{ fact: 'resource.owningStation', to: 'PS-X' }]))
      .to.throw(/not a fact a counterfactual may change/);
  });

  it('returns null for facts the written policy cannot evaluate, instead of guessing', () => {
    expect(counterfactualsFor({ verifiedRequest: null, bundle })).to.equal(null);
    expect(counterfactualsFor({ verifiedRequest: { requester: {}, resource: {}, request: {} }, bundle })).to.equal(null);
  });

  it('checks victim protection and does not turn requester claims into verified facts', () => {
    const protectedFacts = verifiedRequestFixture({
      requester: { role: 'lab-analyst', organization: 'forensics', mspId: 'ForensicsMSP' },
      resource: { recordType: 'forensic-report', victimProtectionFlag: true },
    });
    const result = counterfactualsFor({ verifiedRequest: protectedFacts, bundle });
    expect(result.writtenPolicy.blockingClauses).to.include('GP-VICTIM:C1@v1');
    expect(result.changeSets[0].changes[0]).to.include({ fact: 'resource.victimProtectionFlag', authority: AUTHORITY.LEGAL });
    expect(counterfactualsFor({ verifiedRequest: { ...protectedFacts, requesterClaims: { emergencyDeclared: true } }, bundle })).to.equal(null);
  });

  it('is deterministic, supports the single-change ablation, and refuses unsupported policy predicates', () => {
    const request = verifiedRequestFixture(REFUSED.sealedAndNotAssigned);
    expect(counterfactualsFor({ verifiedRequest: request, bundle })).to.deep.equal(counterfactualsFor({ verifiedRequest: request, bundle }));
    expect(counterfactualsFor({ verifiedRequest: request, bundle, maxChanges: 1 }).changeSets).to.deep.equal([]);
    expect(counterfactualsFor({ verifiedRequest: request, bundle, maxChanges: 3 })).to.equal(null);
    expect(counterfactualsFor({ verifiedRequest: request, bundle: null })).to.equal(null);
    const unsupported = structuredClone(bundle);
    unsupported.clauses.push({ ...unsupported.clauses.find((clause) => clause.policyId === 'GP-CRED'), policyId: 'GP-NEW' });
    unsupported.precedence.denyOrder.unshift('GP-NEW:C1@v1');
    expect(counterfactualsFor({ verifiedRequest: request, bundle: unsupported })).to.equal(null);
    expect(() => applyChanges(request, [{ fact: 'resource.sealed', to: 'false' }])).to.throw(/invalid hypothetical/);
    expect(() => applyChanges(request, [{ fact: 'resource.sealed', to: false }, { fact: 'resource.sealed', to: false }])).to.throw(/only once/);
  });
});
