'use strict';

/**
 * Policy package completeness.
 *
 * The bundle is the policy of record: the chaincode hashes it, the prompt
 * renders it, the oracle labels the dataset from it, and the specification is
 * generated from it. These tests check the properties the rest of the system
 * assumes and cannot re-derive for itself.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalize, hashObject, loadBundle } = require('../lib/bundle');
const {
  DENY_PREDICATES, evaluateReference, referenceReason,
} = require('../reference-oracle/referencePolicyOracle');
const {
  RECOMMENDATIONS, validateRecommendationOutput,
} = require('../../chaincode/crimerecords/lib/dias/recommendationSchema');
const { bundleSummary } = require('../../chaincode/crimerecords/lib/policyContract');

const REPO = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const { bundle, bundleHash, clauseRefs } = loadBundle();

test('the bundle hash is stable across serializations', () => {
  // The chaincode recomputes this from the JSON it receives; a hash that depended
  // on key order would make every registration unverifiable.
  const roundTripped = JSON.parse(JSON.stringify(bundle));
  assert.equal(hashObject(roundTripped), bundleHash);
  const shuffled = Object.fromEntries(Object.entries(bundle).reverse());
  assert.equal(hashObject(shuffled), bundleHash);
});

test('the chaincode derives the same hash as the loader', () => {
  assert.equal(bundleSummary(bundle).bundleHash, bundleHash);
});

test('every reason code maps to exactly one recommendation class', () => {
  for (const [code, effect] of Object.entries(bundle.reasonCodes)) {
    assert.ok(RECOMMENDATIONS.includes(effect), `${code} maps to ${effect}`);
  }
  // And no code is reachable from two clauses with opposite effects.
  const byCode = new Map();
  for (const clause of bundle.clauses) {
    if (!clause.reasonCode) continue;
    const seen = byCode.get(clause.reasonCode);
    assert.ok(seen === undefined || seen === clause.effect,
      `${clause.reasonCode} is used by clauses with different effects`);
    byCode.set(clause.reasonCode, clause.effect);
  }
});

test('every clause reason code is declared, and every declared code is used', () => {
  const used = new Set(bundle.clauses.map((c) => c.reasonCode).filter(Boolean));
  const declared = new Set(Object.keys(bundle.reasonCodes));
  assert.deepEqual([...used].filter((c) => !declared.has(c)), [],
    'clauses use reason codes the bundle does not declare');
  assert.deepEqual([...declared].filter((c) => !used.has(c)), [],
    'the bundle declares reason codes no clause can emit');
});

test('every policy reference the bundle names resolves to a clause', () => {
  const refs = new Set(clauseRefs);
  for (const ref of bundle.precedence.denyOrder) assert.ok(refs.has(ref), `${ref} is undefined`);
  for (const ref of bundle.precedence.allowPolicyRefs) assert.ok(refs.has(ref), `${ref} is undefined`);
  assert.ok(refs.has(bundle.precedence.defaultClause));
});

test('precedence covers every DENY clause exactly once, in a fixed order', () => {
  const denyClauses = bundle.clauses
    .filter((c) => c.effect === 'DENY')
    .map((c) => `${c.policyId}:${c.clauseId}@${bundle.version}`);
  assert.deepEqual([...bundle.precedence.denyOrder].sort(), [...denyClauses].sort(),
    'precedence and the DENY clauses disagree');
  assert.equal(new Set(bundle.precedence.denyOrder).size, bundle.precedence.denyOrder.length);
  assert.equal(bundle.precedence.method, 'first-applicable-deny-clause');
});

test('the oracle implements a predicate for every DENY clause and nothing more', () => {
  // Predicates are keyed without the version suffix the bundle uses in refs.
  const denyClauses = bundle.precedence.denyOrder.map((ref) => ref.split('@')[0]);
  assert.deepEqual(Object.keys(DENY_PREDICATES).sort(), [...denyClauses].sort(),
    'the offline oracle and the written policy disagree about which clauses can deny');
});

test('the oracle reports the first applicable clause and lists them all', () => {
  // A request that fails on several independent grounds at once.
  const verdict = evaluateReference(bundle, {
    requester: {
      mspId: 'PoliceMSP', organization: 'police', role: 'constable', rank: '1',
      station: 'PS-East', jurisdiction: 'district-south', clearance: 'low',
      credentialStatus: 'suspended', assignedToRequestedCase: false,
    },
    resource: {
      recordType: 'forensic-report', caseId: 'CASE-1', sensitivityLevel: 'high',
      jurisdiction: 'district-north', owningAgency: 'forensics', owningStation: 'FSL-1',
      sealed: true, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
    },
    request: { action: 'export', purpose: 'investigation', emergencyFlag: false, approvalTokenPresent: false },
  });

  assert.equal(verdict.recommendation, 'DENY');
  assert.equal(verdict.reason_code, 'CRED_NOT_ACTIVE', 'the first clause in precedence decides');
  assert.ok(verdict.policy_refs.length > 1, 'every applicable clause must be listed');
  assert.equal(verdict.policy_refs[0], 'GP-CRED:C1@v1', 'the decisive clause comes first');
  // The listed refs must appear in precedence order, not in discovery order.
  const positions = verdict.policy_refs.map((ref) => bundle.precedence.denyOrder.indexOf(ref));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('every oracle verdict satisfies the response schema the chaincode enforces', () => {
  const policy = {
    clauseRefs,
    reasonCodes: bundle.reasonCodes,
    reviewFlags: Object.keys(bundle.reviewFlags),
  };
  const base = {
    requester: {
      mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3',
      station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high',
      credentialStatus: 'active', assignedToRequestedCase: true,
    },
    resource: {
      recordType: 'fir', caseId: 'CASE-1', sensitivityLevel: 'medium',
      jurisdiction: 'district-north', owningAgency: 'police', owningStation: 'PS-Central',
      sealed: false, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
    },
    request: { action: 'view', purpose: 'investigation', emergencyFlag: false, approvalTokenPresent: false },
  };
  const variants = [
    base,
    { ...base, resource: { ...base.resource, sealed: true } },
    { ...base, resource: { ...base.resource, juvenileFlag: true } },
    { ...base, resource: { ...base.resource, victimProtectionFlag: true } },
    { ...base, resource: { ...base.resource, jurisdiction: 'district-south' } },
    { ...base, resource: { ...base.resource, sensitivityLevel: 'high' }, requester: { ...base.requester, clearance: 'low' } },
    { ...base, requester: { ...base.requester, assignedToRequestedCase: false } },
    { ...base, requester: { ...base.requester, credentialStatus: 'revoked' } },
    { ...base, request: { ...base.request, action: 'export' } },
  ];
  for (const variant of variants) {
    const verdict = evaluateReference(bundle, variant);
    // The oracle produces the decision fields; a label is the verdict plus the
    // grounded sentence and the (currently always empty) evidence list.
    const response = {
      recommendation: verdict.recommendation,
      reason_code: verdict.reason_code,
      reason: referenceReason(bundle, variant, verdict),
      policy_refs: verdict.policy_refs,
      missing_evidence: [],
      review_flags: verdict.review_flags,
    };
    assert.deepEqual(validateRecommendationOutput(response, policy), [],
      `oracle verdict rejected by the response schema: ${JSON.stringify(response)}`);
    assert.ok(response.reason.length > 0 && response.reason.length <= 600);
  }
});

test('every review flag the policy defines is documented', () => {
  for (const [flag, text] of Object.entries(bundle.reviewFlags)) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 20, `${flag} has no usable description`);
  }
});

test('the generated specification matches the bundle it documents', () => {
  const spec = read('docs/policies/governance-policy-specification.md');
  assert.ok(spec.includes(bundleHash), 'the specification does not quote the current bundle hash');
  for (const ref of clauseRefs) {
    assert.ok(spec.includes(ref), `the specification omits clause ${ref}`);
  }
  for (const code of Object.keys(bundle.reasonCodes)) {
    assert.ok(spec.includes(code), `the specification omits reason code ${code}`);
  }
});

test('the open-questions document exists and is current for this bundle', () => {
  // The bundle's provenance block points at this file; a dangling pointer would
  // mean the policy of record cites documentation that does not exist.
  const target = bundle.provenance.openQuestions;
  assert.equal(target, 'docs/policies/policy-open-questions.md');
  const doc = read(target);
  assert.ok(doc.includes(bundleHash), 'the open-questions document names a different bundle hash');
  assert.match(doc, /synthetic research policy/i,
    'the synthetic nature of the policy must be stated');
  assert.match(doc, /not\*{0,2}\s+an official police/i,
    'the document must say the policy is not an official one');
  // Every deliberate divergence from the source tables must be discussed.
  for (const change of bundle.provenance.changesFromSource) {
    const topic = change.split(':')[0].trim();
    assert.ok(doc.toLowerCase().includes(topic.toLowerCase().split(' ')[0]),
      `the open-questions document does not discuss "${topic}"`);
  }
});

test('the canonicalizer is byte-identical to the chaincode implementation', () => {
  const chain = require('../../chaincode/crimerecords/lib/util/validate').canonicalize;
  assert.equal(canonicalize(bundle), chain(bundle));
});
