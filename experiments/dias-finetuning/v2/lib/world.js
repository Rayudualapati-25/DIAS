'use strict';

/**
 * The synthetic world the dataset is drawn from.
 *
 * Districts and stations are real, distinct names. v1 expressed a
 * cross-jurisdiction case as the literal string `outside-<district>`, which made
 * the label readable from the surface form of one field; a model could score
 * perfectly on cross-jurisdiction examples without comparing the two
 * jurisdictions at all. Here a mismatch is simply two different district names,
 * so the comparison has to be performed.
 */

const DISTRICTS = Object.freeze([
  'north-hills', 'riverside', 'old-town', 'harbour-point', 'eastgate',
  'westfield', 'silver-creek', 'lakeview', 'stonebridge', 'fairmount',
]);

const STATION_PREFIX = Object.freeze({
  police: 'PS', forensics: 'FSL', prosecution: 'PO', court: 'CT',
});

const MSP_BY_ORGANIZATION = Object.freeze({
  police: 'PoliceMSP',
  forensics: 'ForensicsMSP',
  prosecution: 'ProsecutionMSP',
  court: 'CourtMSP',
});

const CREDENTIAL_STATUSES = Object.freeze(['active', 'suspended', 'revoked', 'expired']);

/** A station name inside a district: `PS-riverside-2`. */
function stationIn(organization, district, index) {
  return `${STATION_PREFIX[organization]}-${district}-${index}`;
}

/**
 * Roles grouped by the policy property that matters for a scenario, computed
 * from the bundle rather than restated, so a policy change cannot leave a stale
 * list behind in the generator.
 */
function roleIndex(bundle) {
  const roles = Object.entries(bundle.roles).map(([role, meta]) => ({
    role,
    organization: meta.organization,
    rank: meta.rank,
    mspId: MSP_BY_ORGANIZATION[meta.organization],
    permissions: bundle.rbac[role] || {},
    assignmentExempt: bundle.roleLists.assignmentExempt.includes(role),
    juvenileAuthorized: bundle.roleLists.juvenileAuthorized.includes(role),
    victimBlocked: bundle.roleLists.victimDataBlocked.includes(role),
  }));
  return {
    all: roles,
    byRole: new Map(roles.map((entry) => [entry.role, entry])),
    /** Roles that may perform `action` on `recordType`. */
    permitted: (action, recordType) => roles.filter(
      (entry) => (entry.permissions[action] || []).includes(recordType)
    ),
    /** Roles that may not. */
    forbidden: (action, recordType) => roles.filter(
      (entry) => !(entry.permissions[action] || []).includes(recordType)
    ),
    /** Every (action, recordType) pair a role is allowed to perform. */
    allowedPairs: (role) => Object.entries(roles.find((e) => e.role === role).permissions)
      .flatMap(([action, types]) => types.map((recordType) => ({ action, recordType }))),
  };
}

/** Sensitivity levels a clearance satisfies, and those it does not. */
function clearanceSplit(bundle, clearance) {
  const order = bundle.vocabularies.clearanceOrder;
  const level = order.indexOf(clearance);
  return {
    satisfied: order.filter((s) => order.indexOf(s) <= level),
    unsatisfied: order.filter((s) => order.indexOf(s) > level),
  };
}

module.exports = {
  CREDENTIAL_STATUSES,
  DISTRICTS,
  MSP_BY_ORGANIZATION,
  STATION_PREFIX,
  clearanceSplit,
  roleIndex,
  stationIn,
};
