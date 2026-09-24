'use strict';

/**
 * Scenario constructors.
 *
 * Each constructor builds a verified request that exercises one policy situation
 * by construction, then lets the offline oracle label it. The constructor never
 * decides the label: it decides the *situation*, and if a constructor and the
 * oracle ever disagree about what situation was built, the validator catches it.
 *
 * Two properties every constructor must preserve:
 *
 *   - Policy-irrelevant fields (emergencyFlag, approvalTokenPresent, witnessFlag,
 *     rank, station, owning agency and station) are drawn independently of the
 *     label. v1 set emergencyFlag to false in every single example, which made
 *     it useless as a distractor and untested as a non-exception.
 *   - Fields the scenario is not about are drawn from the full legal range, not
 *     pinned to a convenient value. v1 used only `high` and `low` clearance, so
 *     the ordered comparison was never exercised.
 */

const { CREDENTIAL_STATUSES, DISTRICTS, clearanceSplit, roleIndex, stationIn } = require('./world');
const {
  evaluateReference,
} = require('../../../../policies/reference-oracle/referencePolicyOracle');

const INACTIVE_CREDENTIALS = CREDENTIAL_STATUSES.filter((s) => s !== 'active');

/** Independent draws for everything the scenario is not about. */
function ambientFacts(rng, bundle, { organization, district }) {
  return {
    rank: String(rng.int(1, 7)),
    station: stationIn(organization, district, rng.int(1, 4)),
    // Both flags are policy-irrelevant under GP-CONTEXT:C1 and must therefore be
    // uncorrelated with the label; they are drawn here and nowhere else.
    emergencyFlag: rng.bool(0.25),
    approvalTokenPresent: rng.bool(0.25),
    witnessFlag: rng.bool(0.3),
  };
}

function assemble({ requester, resource, request }) {
  return { requester, resource, request };
}

/**
 * What the oracle says about these facts.
 *
 * The oracle needs a caseId, which the constructors leave for the generator to
 * fill with a neutral identifier, so a placeholder is supplied here. It affects
 * no clause: no clause in policy v1 reads the case identifier.
 */
function verdictFor(bundle, facts) {
  return evaluateReference(bundle, {
    ...facts,
    resource: { ...facts.resource, caseId: facts.resource.caseId || 'CASE-PLACEHOLDER' },
  });
}

/**
 * Facts only if they really exhibit the clauses the caller asked for.
 *
 * Mutations interact: replacing a role to break the organization clause can
 * simultaneously satisfy the juvenile clause, so a scenario that names two
 * clauses may end up exhibiting one. Returning null lets the caller retry with a
 * different base rather than silently producing an example whose recorded
 * `targetClauses` is a fiction.
 */
function onlyIfExhibits(bundle, facts, clauses) {
  if (facts === null || facts === undefined) return null;
  if (clauses.length === 0) {
    return verdictFor(bundle, facts).recommendation === 'ALLOW' ? facts : null;
  }
  const applicable = new Set(verdictFor(bundle, facts).applicable_deny_clauses);
  return clauses.every((clause) => applicable.has(`${clause}@v1`)) ? facts : null;
}

/**
 * Build a request that satisfies every clause. Everything not fixed by the
 * ALLOW requirement is drawn freely, so clean examples span the whole world.
 */
function cleanAllow(rng, bundle, index = roleIndex(bundle)) {
  const order = bundle.vocabularies.clearanceOrder;
  const role = rng.pick(index.all.filter((entry) => index.allowedPairs(entry.role).length > 0));
  const pair = rng.pick(index.allowedPairs(role.role));
  const district = rng.pick(DISTRICTS);
  const clearance = rng.pick(order);
  const { satisfied } = clearanceSplit(bundle, clearance);
  const ambient = ambientFacts(rng, bundle, { organization: role.organization, district });
  const juvenile = role.juvenileAuthorized ? rng.bool(0.25) : false;
  const victim = role.victimBlocked ? false : rng.bool(0.25);
  return assemble({
    requester: {
      mspId: role.mspId,
      organization: role.organization,
      role: role.role,
      rank: ambient.rank,
      station: ambient.station,
      jurisdiction: district,
      clearance,
      credentialStatus: 'active',
      assignedToRequestedCase: role.assignmentExempt ? rng.bool(0.5) : true,
    },
    resource: {
      recordType: pair.recordType,
      caseId: null,
      sensitivityLevel: rng.pick(satisfied),
      jurisdiction: district,
      owningAgency: rng.pick(['police', 'forensics', 'prosecution', 'court']),
      owningStation: stationIn(rng.pick(['police', 'forensics']), district, rng.int(1, 4)),
      sealed: role.mspId === 'CourtMSP' ? rng.bool(0.3) : false,
      juvenileFlag: juvenile,
      witnessFlag: ambient.witnessFlag,
      victimProtectionFlag: victim,
    },
    request: {
      action: pair.action,
      purpose: rng.pick(bundle.vocabularies.purposes),
      emergencyFlag: ambient.emergencyFlag,
      approvalTokenPresent: ambient.approvalTokenPresent,
    },
  });
}

/** Mutations, each of which introduces exactly one DENY clause into a clean request. */
const SINGLE_VIOLATIONS = Object.freeze({
  'GP-CRED:C1': (rng, bundle, base) => ({
    ...base,
    requester: { ...base.requester, credentialStatus: rng.pick(INACTIVE_CREDENTIALS) },
  }),
  'GP-RBAC:C1': (rng, bundle, base, index) => {
    // A role that exists but does not belong to the requester's verified MSP.
    const foreign = rng.pick(index.all.filter((e) => e.mspId !== base.requester.mspId));
    return { ...base, requester: { ...base.requester, role: foreign.role } };
  },
  'GP-RBAC:C2': (rng, bundle, base, index) => {
    const entry = index.byRole.get(base.requester.role);
    const forbidden = bundle.vocabularies.actions.flatMap((action) =>
      bundle.vocabularies.recordTypes
        .filter((recordType) => !(entry.permissions[action] || []).includes(recordType))
        .map((recordType) => ({ action, recordType })));
    if (forbidden.length === 0) return null;
    const pick = rng.pick(forbidden);
    return {
      ...base,
      resource: { ...base.resource, recordType: pick.recordType },
      request: { ...base.request, action: pick.action },
    };
  },
  'GP-SEAL:C1': (rng, bundle, base) => (base.requester.mspId === 'CourtMSP' ? null : {
    ...base,
    resource: { ...base.resource, sealed: true },
  }),
  'GP-JUV:C1': (rng, bundle, base, index) => (
    index.byRole.get(base.requester.role).juvenileAuthorized ? null : {
      ...base,
      resource: { ...base.resource, juvenileFlag: true },
    }),
  'GP-VICTIM:C1': (rng, bundle, base, index) => (
    index.byRole.get(base.requester.role).victimBlocked ? {
      ...base,
      resource: { ...base.resource, victimProtectionFlag: true },
    } : null),
  'GP-JURIS:C1': (rng, bundle, base) => {
    const elsewhere = rng.pick(DISTRICTS.filter((d) => d !== base.requester.jurisdiction));
    return { ...base, resource: { ...base.resource, jurisdiction: elsewhere } };
  },
  'GP-ASSIGN:C1': (rng, bundle, base, index) => (
    index.byRole.get(base.requester.role).assignmentExempt ? null : {
      ...base,
      requester: { ...base.requester, assignedToRequestedCase: false },
    }),
  'GP-CLEAR:C1': (rng, bundle, base) => {
    const { unsatisfied } = clearanceSplit(bundle, base.requester.clearance);
    if (unsatisfied.length === 0) return null;
    return { ...base, resource: { ...base.resource, sensitivityLevel: rng.pick(unsatisfied) } };
  },
});

/** Every clause a single mutation can introduce. GP-PURPOSE is excluded deliberately. */
const SINGLE_VIOLATION_CLAUSES = Object.freeze(Object.keys(SINGLE_VIOLATIONS));

/**
 * A request violating exactly the named clause, or null when this clean base
 * cannot express that violation (a court identity cannot fail the seal clause).
 * Callers retry with a different base rather than forcing an unnatural one.
 */
function singleViolation(rng, bundle, clause, index = roleIndex(bundle)) {
  const base = cleanAllow(rng, bundle, index);
  const mutate = SINGLE_VIOLATIONS[clause];
  if (!mutate) throw new Error(`no mutation for clause '${clause}'`);
  return onlyIfExhibits(bundle, mutate(rng, bundle, base, index), [clause]);
}

/** A request violating several clauses at once, to exercise precedence. */
function multiViolation(rng, bundle, clauses, index = roleIndex(bundle)) {
  let facts = cleanAllow(rng, bundle, index);
  for (const clause of clauses) {
    const mutated = SINGLE_VIOLATIONS[clause](rng, bundle, facts, index);
    if (mutated === null) return null;
    facts = mutated;
  }
  return onlyIfExhibits(bundle, facts, clauses);
}

/**
 * A near miss: one field away from the opposite label. These are where a model
 * that has learned surface correlations rather than the policy fails, so they
 * are generated deliberately rather than left to chance.
 */
const NEAR_MISS_BUILDERS = Object.freeze({
  /** Clearance exactly meets sensitivity — allowed — versus one level short. */
  'clearance-boundary': (rng, bundle, index) => {
    const order = bundle.vocabularies.clearanceOrder;
    const level = rng.int(0, order.length - 1);
    const base = cleanAllow(rng, bundle, index);
    const meets = {
      ...base,
      requester: { ...base.requester, clearance: order[level] },
      resource: { ...base.resource, sensitivityLevel: order[level] },
    };
    if (level === 0) return { allow: meets, deny: null };
    const short = {
      ...base,
      requester: { ...base.requester, clearance: order[level - 1] },
      resource: { ...base.resource, sensitivityLevel: order[level] },
    };
    return { allow: meets, deny: short };
  },
  /** Same district spelled identically versus a different district. */
  'jurisdiction-boundary': (rng, bundle, index) => {
    const base = cleanAllow(rng, bundle, index);
    const other = rng.pick(DISTRICTS.filter((d) => d !== base.requester.jurisdiction));
    return {
      allow: base,
      deny: { ...base, resource: { ...base.resource, jurisdiction: other } },
    };
  },
  /** An assignment-exempt role unassigned (allowed) versus a non-exempt one. */
  'assignment-exemption': (rng, bundle, index) => {
    const exempt = rng.pick(index.all.filter((e) => e.assignmentExempt && index.allowedPairs(e.role).length));
    const plain = rng.pick(index.all.filter((e) => !e.assignmentExempt && index.allowedPairs(e.role).length));
    const build = (entry) => {
      const base = cleanAllow(rng, bundle, index);
      const pair = rng.pick(index.allowedPairs(entry.role));
      return {
        ...base,
        requester: {
          ...base.requester,
          mspId: entry.mspId,
          organization: entry.organization,
          role: entry.role,
          assignedToRequestedCase: false,
        },
        resource: { ...base.resource, recordType: pair.recordType, sealed: entry.mspId === 'CourtMSP' ? base.resource.sealed : false },
        request: { ...base.request, action: pair.action },
      };
    };
    return { allow: build(exempt), deny: build(plain) };
  },
  /** A juvenile record for an authorized role versus an unauthorized one. */
  'juvenile-authorization': (rng, bundle, index) => {
    const allowed = rng.pick(index.all.filter((e) => e.juvenileAuthorized && index.allowedPairs(e.role).length));
    const blocked = rng.pick(index.all.filter((e) => !e.juvenileAuthorized && index.allowedPairs(e.role).length));
    const build = (entry) => {
      const base = cleanAllow(rng, bundle, index);
      const pair = rng.pick(index.allowedPairs(entry.role));
      return {
        ...base,
        requester: {
          ...base.requester,
          mspId: entry.mspId,
          organization: entry.organization,
          role: entry.role,
          assignedToRequestedCase: true,
        },
        resource: {
          ...base.resource,
          recordType: pair.recordType,
          juvenileFlag: true,
          sealed: entry.mspId === 'CourtMSP' ? base.resource.sealed : false,
          victimProtectionFlag: entry.victimBlocked ? false : base.resource.victimProtectionFlag,
        },
        request: { ...base.request, action: pair.action },
      };
    };
    return { allow: build(allowed), deny: build(blocked) };
  },
  /** One permitted (action, recordType) pair versus one adjacent forbidden pair. */
  'rbac-adjacent': (rng, bundle, index) => {
    const entry = rng.pick(index.all.filter((e) => index.allowedPairs(e.role).length > 0));
    const allowedPairs = index.allowedPairs(entry.role);
    const pair = rng.pick(allowedPairs);
    const forbidden = bundle.vocabularies.recordTypes
      .filter((recordType) => !(entry.permissions[pair.action] || []).includes(recordType));
    const base = cleanAllow(rng, bundle, index);
    const shaped = {
      ...base,
      requester: {
        ...base.requester, mspId: entry.mspId, organization: entry.organization,
        role: entry.role, assignedToRequestedCase: true,
      },
      resource: {
        ...base.resource,
        sealed: entry.mspId === 'CourtMSP' ? base.resource.sealed : false,
        juvenileFlag: entry.juvenileAuthorized ? base.resource.juvenileFlag : false,
        victimProtectionFlag: entry.victimBlocked ? false : base.resource.victimProtectionFlag,
      },
      request: { ...base.request, action: pair.action },
    };
    return {
      allow: { ...shaped, resource: { ...shaped.resource, recordType: pair.recordType } },
      deny: forbidden.length === 0 ? null
        : { ...shaped, resource: { ...shaped.resource, recordType: rng.pick(forbidden) } },
    };
  },
});

const NEAR_MISS_KINDS = Object.freeze(Object.keys(NEAR_MISS_BUILDERS));

/**
 * A near-miss pair, or a pair with a null half when the construction did not
 * actually produce opposite labels. The caller retries rather than emitting a
 * pair that does not demonstrate the boundary it is named for.
 */
function nearMiss(rng, bundle, kind, index = roleIndex(bundle)) {
  const pair = NEAR_MISS_BUILDERS[kind](rng, bundle, index);
  return {
    allow: pair.allow && verdictFor(bundle, pair.allow).recommendation === 'ALLOW' ? pair.allow : null,
    deny: pair.deny && verdictFor(bundle, pair.deny).recommendation === 'DENY' ? pair.deny : null,
  };
}

module.exports = {
  NEAR_MISS_BUILDERS,
  onlyIfExhibits,
  verdictFor,
  NEAR_MISS_KINDS,
  SINGLE_VIOLATIONS,
  SINGLE_VIOLATION_CLAUSES,
  ambientFacts,
  cleanAllow,
  multiViolation,
  nearMiss,
  singleViolation,
};
