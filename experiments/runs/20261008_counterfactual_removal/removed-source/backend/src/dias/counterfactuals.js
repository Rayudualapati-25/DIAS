'use strict';

/**
 * Written-policy hypotheticals, never authorization or model correction.
 * Only this runtime module may reach the reference oracle (design section 13).
 * The requester's claims and the LLM's answer are deliberately not inputs.
 */
const { evaluateReference } = require('../../../policies/reference-oracle/referencePolicyOracle');
const { validateBundle } = require('../../../policies/lib/bundle');
const { policyHashOf, policyVersionOf } = require('../../../chaincode/crimerecords/lib/dias/policyRegistry');
const {
  validateVerifiedRequest, verifiedRequestHash, VERIFIED_REQUEST_SCHEMA_VERSION,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');

const COUNTERFACTUAL_SCHEMA_VERSION = 'dias-counterfactuals-v1';
const MAX_CHANGES = 2;
const AUTHORITY = Object.freeze({ REQUESTER: 'REQUESTER', ADMINISTRATIVE: 'ADMINISTRATIVE', LEGAL: 'LEGAL' });
const FACTS = Object.freeze({
  'request.action': [AUTHORITY.REQUESTER, 'string'],
  'request.purpose': [AUTHORITY.REQUESTER, 'string'],
  'requester.credentialStatus': [AUTHORITY.ADMINISTRATIVE, 'string'],
  'requester.assignedToRequestedCase': [AUTHORITY.ADMINISTRATIVE, 'boolean'],
  'requester.clearance': [AUTHORITY.ADMINISTRATIVE, 'string'],
  'resource.sensitivityLevel': [AUTHORITY.ADMINISTRATIVE, 'string'],
  'resource.sealed': [AUTHORITY.LEGAL, 'boolean'],
  'resource.juvenileFlag': [AUTHORITY.LEGAL, 'boolean'],
  'resource.victimProtectionFlag': [AUTHORITY.LEGAL, 'boolean'],
});

/** Apply only permitted hypothetical facts to an independent copy. */
function applyChanges(verifiedRequest, changes) {
  if (validateVerifiedRequest(verifiedRequest).length) throw new Error('invalid verified context');
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) throw new Error('too many hypothetical changes');
  const changed = Object.fromEntries(Object.entries(verifiedRequest).map(([key, value]) => [key, { ...value }]));
  const seen = new Set();
  for (const { fact, to } of changes) {
    if (!Object.hasOwn(FACTS, fact)) throw new Error(`${fact} is not a fact a counterfactual may change`);
    if (seen.has(fact)) throw new Error('a fact may change only once');
    if (typeof to !== FACTS[fact][1] || (typeof to === 'string' && (!to.length || to.length > 128))) {
      throw new Error('invalid hypothetical value');
    }
    seen.add(fact);
    const [group, field] = fact.split('.');
    changed[group][field] = to;
  }
  return changed;
}

/** Candidate generation is exported for the offline verification ablation only. */
function candidateChanges(verifiedRequest, bundle) {
  const changes = [];
  const add = (fact, to, description) => {
    const [group, field] = fact.split('.');
    const from = verifiedRequest[group][field];
    if (from !== to) changes.push({ fact, from, to, authority: FACTS[fact][0], description });
  };
  const { requester, resource } = verifiedRequest;
  add('requester.credentialStatus', 'active', 'the responsible authority reinstates the officer\'s credential');
  add('requester.assignedToRequestedCase', true, 'the officer is assigned to the requested case');
  const order = bundle.vocabularies.clearanceOrder;
  const held = order.indexOf(requester.clearance);
  const needed = order.indexOf(resource.sensitivityLevel) >= 0
    ? order.indexOf(resource.sensitivityLevel) : order.indexOf(bundle.vocabularies.unknownSensitivityTreatedAs);
  if (held < needed) {
    add('requester.clearance', order[needed], `the responsible authority raises the officer's clearance to ${order[needed]}`);
    if (held >= 0) add('resource.sensitivityLevel', order[held],
      `the responsible authority lawfully reclassifies the record to ${order[held]} sensitivity`);
  }
  if (resource.sealed) add('resource.sealed', false, 'the court unseals the record');
  if (resource.juvenileFlag) add('resource.juvenileFlag', false, 'the juvenile-protection restriction is lawfully lifted');
  if (resource.victimProtectionFlag) add('resource.victimProtectionFlag', false, 'the victim-protection restriction is lawfully lifted');
  for (const action of bundle.vocabularies.actions) add('request.action', action, `the officer requests ${action} instead`);
  // Every defined purpose is currently permitted by GP-PURPOSE:C1. Do not
  // propose a new purpose when the current one already satisfies that clause.
  if (!bundle.vocabularies.purposes.includes(verifiedRequest.request.purpose)) {
    for (const purpose of bundle.vocabularies.purposes) add('request.purpose', purpose,
      `the request has the legitimate purpose ${purpose}`);
  }
  return changes.sort((a, b) => a.fact.localeCompare(b.fact, 'en') || String(a.to).localeCompare(String(b.to), 'en'));
}

function changeSetsFrom(candidates, maxChanges = MAX_CHANGES) {
  const sets = candidates.map((change) => [change]);
  if (maxChanges === 2) {
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        if (candidates[i].fact !== candidates[j].fact) sets.push([candidates[i], candidates[j]]);
      }
    }
  }
  return sets;
}

/** Keep only inclusion-minimal sufficient sets, bounded by two changed facts. */
function counterfactualsFor({ verifiedRequest, bundle, maxChanges = MAX_CHANGES }) {
  if (![1, 2].includes(maxChanges) || validateVerifiedRequest(verifiedRequest).length) return null;
  try {
    if (validateBundle(bundle).length) return null;
    const original = evaluateReference(bundle, verifiedRequest);
    const blockingClauses = original.applicable_deny_clauses;
    const changeSets = [];
    if (original.recommendation === 'DENY') {
      for (const changes of changeSetsFrom(candidateChanges(verifiedRequest, bundle), maxChanges)) {
        if (changeSets.some((kept) => kept.changes.every((change) =>
          changes.some((item) => item.fact === change.fact && item.to === change.to)))) continue;
        if (evaluateReference(bundle, applyChanges(verifiedRequest, changes)).recommendation === 'ALLOW') {
          changeSets.push({ changes, writtenPolicyResultAfter: 'ALLOW' });
        }
      }
    }
    return {
      schemaVersion: COUNTERFACTUAL_SCHEMA_VERSION,
      writtenPolicy: { result: original.recommendation, blockingClauses: [...blockingClauses] },
      changeSets,
      unresolvedClauses: changeSets.length ? [] : [...blockingClauses],
      maxChanges,
    };
  } catch (_error) {
    // Incomplete or unsupported policy/facts produce no invented explanation.
    return null;
  }
}

const mayExplain = (detail) => detail.explanationVisible === true
  && (detail.viewer === 'auditor'
    || (detail.viewer === 'requester' && detail.decision?.decision === 'FORCE_DENY'));

/** Bind hints to C and the policy frozen on this ledger request. */
function counterfactualsForTrail({ detail, request, bundle }) {
  if (!mayExplain(detail)) return null;
  const unavailable = (reason) => ({ available: false, reason });
  if (!request || request.verifiedRequestSchemaVersion !== VERIFIED_REQUEST_SCHEMA_VERSION
    || validateVerifiedRequest(request.verifiedRequest).length) return unavailable('facts-unavailable');
  if (verifiedRequestHash(request.verifiedRequest) !== request.verifiedRequestHash) return unavailable('context-mismatch');
  try {
    if (request.policyVersion !== policyVersionOf(bundle) || request.policyHash !== policyHashOf(bundle)) {
      return unavailable('policy-mismatch');
    }
    const result = counterfactualsFor({ verifiedRequest: request.verifiedRequest, bundle });
    return result ? { available: true, ...result } : unavailable('policy-unavailable');
  } catch (_error) {
    return unavailable('policy-unavailable');
  }
}

module.exports = {
  AUTHORITY, COUNTERFACTUAL_SCHEMA_VERSION, MAX_CHANGES, applyChanges, candidateChanges,
  changeSetsFrom, counterfactualsFor, counterfactualsForTrail, mayExplain,
};
