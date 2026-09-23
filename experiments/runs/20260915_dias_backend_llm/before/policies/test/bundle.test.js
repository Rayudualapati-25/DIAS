'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const {
  CLAUSE_REF_PATTERN, DEFAULT_BUNDLE_PATH, canonicalize, hashObject, loadBundle, validateBundle,
} = require('../lib/bundle');
const { deriveBundle } = require('../tools/derive-governance-policy-v1');

const ROOT = path.resolve(__dirname, '..', '..');
const legacy = require(path.join(ROOT, 'chaincode/crimerecords/lib/policy/policyV1'));

test('committed bundle equals its derivation from the retained policy tables', () => {
  const committed = JSON.parse(fs.readFileSync(DEFAULT_BUNDLE_PATH, 'utf8'));
  assert.equal(canonicalize(committed), canonicalize(deriveBundle()));
});

test('bundle validates and every clause reference has the documented format', () => {
  const { bundle, clauseRefs } = loadBundle();
  assert.deepEqual(validateBundle(bundle), []);
  assert.equal(new Set(clauseRefs).size, clauseRefs.length);
  for (const ref of clauseRefs) assert.match(ref, CLAUSE_REF_PATTERN);
});

test('bundle vocabularies and tables match the chaincode copies exactly', () => {
  const { bundle } = loadBundle();
  assert.deepEqual(bundle.vocabularies.actions, [...legacy.ACTIONS]);
  assert.deepEqual(bundle.vocabularies.purposes, [...legacy.PURPOSES]);
  assert.deepEqual(bundle.vocabularies.recordTypes, [...legacy.RECORD_TYPES]);
  assert.deepEqual(bundle.roleLists.assignmentExempt, [...legacy.ASSIGNMENT_EXEMPT]);
  assert.deepEqual(bundle.roleLists.juvenileAuthorized, [...legacy.JUVENILE_ALLOWED]);
  assert.equal(canonicalize(bundle.rbac), canonicalize(legacy.RBAC));
});

test('the only DENY/ALLOW reason codes are the binary recommendation codes', () => {
  const { bundle } = loadBundle();
  assert.deepEqual(new Set(Object.values(bundle.reasonCodes)), new Set(['ALLOW', 'DENY']));
  assert.equal(bundle.reasonCodes.SEALED_RECORD, 'DENY');
  assert.ok(!('MODEL_POLICY_DISAGREEMENT' in bundle.reasonCodes));
});

test('the bundle hash is canonical and changes when a clause changes', () => {
  const { bundle, bundleHash } = loadBundle();
  assert.equal(bundleHash, hashObject(JSON.parse(JSON.stringify(bundle))));
  const altered = JSON.parse(JSON.stringify(bundle));
  altered.clauses[0].text = `${altered.clauses[0].text} changed`;
  assert.notEqual(hashObject(altered), bundleHash);
});

test('validation reports unordered DENY clauses and unknown precedence references', () => {
  const { bundle } = loadBundle();
  const broken = JSON.parse(JSON.stringify(bundle));
  broken.precedence.denyOrder = broken.precedence.denyOrder.slice(1);
  broken.precedence.allowPolicyRefs = ['GP-NOPE:C9@v1'];
  const problems = validateBundle(broken);
  assert.ok(problems.some((problem) => problem.includes('missing from precedence.denyOrder')));
  assert.ok(problems.some((problem) => problem.includes('unknown clause GP-NOPE:C9@v1')));
});

test('loading a missing bundle fails with a clear error', () => {
  assert.throws(() => loadBundle('/nonexistent/bundle.json'), /could not be read/);
});
