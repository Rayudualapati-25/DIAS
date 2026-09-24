'use strict';

/**
 * Canonical DIAS governance policy bundle: loading, validation, hashing, and
 * clause references. Shared by the recommendation runtime, dataset tooling, and
 * evaluation. This module contains no access-decision logic.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_BUNDLE_PATH = path.resolve(__dirname, '..', 'dias-governance-policy-v1.json');
const CLAUSE_REF_PATTERN = /^GP-[A-Z]+:C[0-9]+@v[0-9]+$/;
const EFFECTS = Object.freeze(['ALLOW', 'DENY', 'INFO']);
const REQUIRED_FIELDS = Object.freeze([
  'bundleId', 'version', 'schemaVersion', 'status', 'provenance', 'vocabularies',
  'roles', 'roleLists', 'rbac', 'reasonCodes', 'reviewFlags', 'missingEvidence',
  'precedence', 'clauses',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(value) {
  return sha256(canonicalize(value));
}

function clauseRef(clause, version) {
  return `${clause.policyId}:${clause.clauseId}@${version}`;
}

function validateClauses(bundle) {
  const problems = [];
  const refs = new Set();
  for (const clause of bundle.clauses) {
    const ref = clauseRef(clause, bundle.version);
    if (!CLAUSE_REF_PATTERN.test(ref)) problems.push(`invalid clause reference ${ref}`);
    if (refs.has(ref)) problems.push(`duplicate clause reference ${ref}`);
    refs.add(ref);
    if (!EFFECTS.includes(clause.effect)) problems.push(`${ref}: invalid effect ${clause.effect}`);
    if (clause.effect !== 'INFO' && bundle.reasonCodes[clause.reasonCode] !== clause.effect) {
      problems.push(`${ref}: reason code ${clause.reasonCode} does not carry effect ${clause.effect}`);
    }
    if (typeof clause.text !== 'string' || clause.text.length === 0) {
      problems.push(`${ref}: text is required`);
    }
  }
  return { problems, refs };
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return ['bundle must be an object'];
  }
  const missing = REQUIRED_FIELDS.filter((field) => !(field in bundle));
  if (missing.length > 0) return missing.map((field) => `missing field ${field}`);
  const { problems, refs } = validateClauses(bundle);
  const { denyOrder, defaultClause, allowPolicyRefs } = bundle.precedence;
  const unknown = [...denyOrder, defaultClause, ...allowPolicyRefs]
    .filter((ref) => !refs.has(ref));
  const unordered = bundle.clauses
    .filter((clause) => clause.effect === 'DENY')
    .map((clause) => clauseRef(clause, bundle.version))
    .filter((ref) => !denyOrder.includes(ref));
  return [
    ...problems,
    ...unknown.map((ref) => `precedence references unknown clause ${ref}`),
    ...unordered.map((ref) => `DENY clause ${ref} is missing from precedence.denyOrder`),
  ];
}

function loadBundle(bundlePath = DEFAULT_BUNDLE_PATH) {
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (error) {
    throw new Error(`governance policy bundle could not be read: ${error.message}`);
  }
  const problems = validateBundle(bundle);
  if (problems.length > 0) {
    throw new Error(`governance policy bundle is invalid: ${problems.join('; ')}`);
  }
  return Object.freeze({
    bundle,
    bundleHash: hashObject(bundle),
    clauseRefs: Object.freeze(bundle.clauses.map((clause) => clauseRef(clause, bundle.version))),
    path: bundlePath,
  });
}

function findClause(bundle, ref) {
  return bundle.clauses.find((clause) => clauseRef(clause, bundle.version) === ref) || null;
}

module.exports = {
  CLAUSE_REF_PATTERN,
  DEFAULT_BUNDLE_PATH,
  canonicalize,
  clauseRef,
  findClause,
  hashObject,
  loadBundle,
  sha256,
  validateBundle,
};
