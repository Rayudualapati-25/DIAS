'use strict';

/**
 * The synthetic world the testbed ledger is seeded with.
 *
 * The 20 base identities are exactly those of network/scripts/seed-identities.sh
 * and scripts/seed-users-onchain.js (same roles, clearances, stations,
 * jurisdictions and credential states). Cases and case files extend the two demo
 * cases so that every record type, sensitivity level and protection flag of the
 * governance policy appears, which gives the load generator many distinct
 * requests with known policy outcomes. Every value is synthetic.
 */

const AUTHORITY = [
  { username: 'sp.north', org: 'audit', role: 'sp', displayName: 'SP (district-north)', jurisdiction: 'district-north', clearance: 'high', badgeId: 'A-1001' },
  { username: 'sp.south', org: 'audit', role: 'sp', displayName: 'SP (district-south)', jurisdiction: 'district-south', clearance: 'high', badgeId: 'A-1002' },
  { username: 'cfo.north', org: 'audit', role: 'chief-forensic-officer', displayName: 'Chief Forensic Officer (district-north)', jurisdiction: 'district-north', clearance: 'high', badgeId: 'A-2001' },
  { username: 'dp.north', org: 'audit', role: 'director-of-prosecution', displayName: 'Director of Prosecution (district-north)', jurisdiction: 'district-north', clearance: 'high', badgeId: 'A-3001' },
  { username: 'dj.north', org: 'audit', role: 'district-judge', displayName: 'District Judge (district-north)', jurisdiction: 'district-north', clearance: 'high', badgeId: 'A-4001' },
  { username: 'ci.central', org: 'audit', role: 'circle-inspector', displayName: 'Circle Inspector (PS-Central)', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', badgeId: 'A-5001' },
  { username: 'ci.east', org: 'audit', role: 'circle-inspector', displayName: 'Circle Inspector (PS-East)', station: 'PS-East', jurisdiction: 'district-north', clearance: 'medium', badgeId: 'A-5002' },
  { username: 'ci.south', org: 'audit', role: 'circle-inspector', displayName: 'Circle Inspector (PS-South)', station: 'PS-South', jurisdiction: 'district-south', clearance: 'high', badgeId: 'A-5003' },
];

/**
 * Requester profiles. `certCredentialStatus` is the certificate attribute the
 * policy reads; the on-chain account itself stays active (as in the demo seed,
 * insp.rathore can sign in, and every request is denied for the revoked
 * credential).
 */
const REQUESTERS = [
  { username: 'sho.reddy', org: 'police', role: 'inspector', displayName: 'Insp. K. Reddy (station head, PS-Central)', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', badgeId: 'B-0100', certCredentialStatus: 'active' },
  { username: 'insp.sharma', org: 'police', role: 'inspector', displayName: 'Insp. A. Sharma', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', badgeId: 'B-1001', certCredentialStatus: 'active' },
  { username: 'const.verma', org: 'police', role: 'constable', displayName: 'Const. R. Verma', rank: '1', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'low', badgeId: 'B-2002', certCredentialStatus: 'active' },
  { username: 'io.krishnan', org: 'police', role: 'investigating-officer', displayName: 'IO S. Krishnan', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', badgeId: 'B-3003', certCredentialStatus: 'active' },
  { username: 'insp.rathore', org: 'police', role: 'inspector', displayName: 'Insp. V. Rathore (revoked credential)', rank: '3', station: 'PS-East', jurisdiction: 'district-north', clearance: 'high', badgeId: 'B-4004', certCredentialStatus: 'revoked' },
  { username: 'insp.singh', org: 'police', role: 'inspector', displayName: 'Insp. P. Singh (cross-district)', rank: '3', station: 'PS-South', jurisdiction: 'district-south', clearance: 'high', badgeId: 'B-5005', certCredentialStatus: 'active' },
  { username: 'analyst.rao', org: 'forensics', role: 'lab-analyst', displayName: 'Analyst P. Rao', station: 'FSL-North', jurisdiction: 'district-north', clearance: 'medium', badgeId: 'F-3001', certCredentialStatus: 'active' },
  { username: 'dir.iyer', org: 'forensics', role: 'lab-director', displayName: 'Dir. M. Iyer', station: 'FSL-North', jurisdiction: 'district-north', clearance: 'high', badgeId: 'F-0001', certCredentialStatus: 'active' },
  { username: 'pp.mehta', org: 'prosecution', role: 'public-prosecutor', displayName: 'PP D. Mehta', jurisdiction: 'district-north', clearance: 'high', badgeId: 'P-5001', certCredentialStatus: 'active' },
  { username: 'dc.nair', org: 'prosecution', role: 'defense-counsel', displayName: 'Adv. L. Nair', jurisdiction: 'district-north', clearance: 'low', badgeId: 'P-6001', certCredentialStatus: 'active' },
  { username: 'judge.rana', org: 'court', role: 'judge', displayName: 'Hon. Justice Rana', jurisdiction: 'district-north', clearance: 'high', badgeId: 'C-7001', certCredentialStatus: 'active' },
  { username: 'clerk.das', org: 'court', role: 'court-clerk', displayName: 'Clerk B. Das', jurisdiction: 'district-north', clearance: 'low', badgeId: 'C-8001', certCredentialStatus: 'active' },
];

/** Registrar (district head) that admits users of each department. */
const REGISTRAR = Object.freeze({
  police: 'sp.north', forensics: 'cfo.north', prosecution: 'dp.north', court: 'dj.north', audit: 'sp.north',
});

/**
 * Case assignments: the demo cases of scripts/seed-domain.js, plus the constable
 * and the lab analyst on CASE-2026-001 (so low and medium clearances meet
 * higher-sensitivity records), plus a south-district case.
 */
const CASES = [
  { caseId: 'CASE-2026-001', owningAgency: 'police', jurisdiction: 'district-north', status: 'under-investigation', protectedClassifications: [], assignedProfiles: ['insp.sharma', 'io.krishnan', 'const.verma', 'analyst.rao'] },
  { caseId: 'CASE-2026-002', owningAgency: 'police', jurisdiction: 'district-north', status: 'under-investigation', protectedClassifications: ['juvenile'], assignedProfiles: ['insp.sharma'] },
  { caseId: 'CASE-2026-003', owningAgency: 'police', jurisdiction: 'district-south', status: 'under-investigation', protectedClassifications: [], assignedProfiles: ['insp.singh'] },
];

const north = { owningStation: 'PS-Central', jurisdiction: 'district-north' };
const south = { owningStation: 'PS-South', jurisdiction: 'district-south' };

const RECORDS = [
  { recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'medium', ...north },
  { recordId: 'REC-EVIDENCE-001', caseId: 'CASE-2026-001', recordType: 'evidence', sensitivityLevel: 'medium', victimProtectionFlag: true, ...north },
  { recordId: 'REC-FIR-002', caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'low', ...north },
  { recordId: 'REC-DIARY-001', caseId: 'CASE-2026-001', recordType: 'case-diary', sensitivityLevel: 'medium', ...north },
  { recordId: 'REC-DIARY-002', caseId: 'CASE-2026-001', recordType: 'case-diary', sensitivityLevel: 'high', ...north },
  { recordId: 'REC-EVIDENCE-002', caseId: 'CASE-2026-001', recordType: 'evidence', sensitivityLevel: 'high', ...north },
  { recordId: 'REC-FORENSIC-001', caseId: 'CASE-2026-001', recordType: 'forensic-report', sensitivityLevel: 'high', ...north },
  { recordId: 'REC-FORENSIC-002', caseId: 'CASE-2026-001', recordType: 'forensic-report', sensitivityLevel: 'medium', ...north },
  { recordId: 'REC-WITNESS-001', caseId: 'CASE-2026-001', recordType: 'witness-statement', sensitivityLevel: 'low', witnessFlag: true, ...north },
  { recordId: 'REC-WITNESS-002', caseId: 'CASE-2026-001', recordType: 'witness-statement', sensitivityLevel: 'medium', witnessFlag: true, ...north },
  { recordId: 'REC-CHARGE-001', caseId: 'CASE-2026-001', recordType: 'chargesheet', sensitivityLevel: 'low', ...north },
  { recordId: 'REC-CHARGE-002', caseId: 'CASE-2026-001', recordType: 'chargesheet', sensitivityLevel: 'medium', ...north },
  { recordId: 'REC-ORDER-001', caseId: 'CASE-2026-001', recordType: 'court-order', sensitivityLevel: 'low', ...north },
  { recordId: 'REC-ORDER-002', caseId: 'CASE-2026-001', recordType: 'court-order', sensitivityLevel: 'medium', ...north },
  { recordId: 'REC-JUVENILE-001', caseId: 'CASE-2026-002', recordType: 'fir', sensitivityLevel: 'high', juvenileFlag: true, ...north },
  { recordId: 'REC-JUVENILE-002', caseId: 'CASE-2026-002', recordType: 'case-diary', sensitivityLevel: 'medium', juvenileFlag: true, ...north },
  { recordId: 'REC-SOUTH-FIR-001', caseId: 'CASE-2026-003', recordType: 'fir', sensitivityLevel: 'medium', ...south },
  { recordId: 'REC-SOUTH-EVIDENCE-001', caseId: 'CASE-2026-003', recordType: 'evidence', sensitivityLevel: 'low', ...south },
  { recordId: 'REC-SOUTH-CHARGE-001', caseId: 'CASE-2026-003', recordType: 'chargesheet', sensitivityLevel: 'low', ...south },
  { recordId: 'REC-SOUTH-DIARY-001', caseId: 'CASE-2026-003', recordType: 'case-diary', sensitivityLevel: 'medium', ...south },
].map((record) => ({
  juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false, owningAgency: 'police', ...record,
}));

const MSP = Object.freeze({
  police: 'PoliceMSP', forensics: 'ForensicsMSP', prosecution: 'ProsecutionMSP', court: 'CourtMSP', audit: 'AuditMSP',
});

/** Certificate attributes, in the ":ecert" form seed-identities.sh uses. */
function certAttributes(user) {
  const pairs = [['role', user.role]];
  if (user.rank) pairs.push(['rank', user.rank]);
  if (user.station) pairs.push(['station', user.station]);
  pairs.push(['jurisdiction', user.jurisdiction], ['badgeId', user.badgeId], ['clearance', user.clearance]);
  pairs.push(['credentialStatus', user.certCredentialStatus || 'active']);
  if (user.caseAssignments && user.caseAssignments.length > 0) {
    pairs.push(['caseAssignments', user.caseAssignments.join('|')]);
  }
  return pairs.map(([key, value]) => `${key}=${value}:ecert`).join(',');
}

/** The case IDs a profile is assigned to (its Case.assignedUsers membership). */
function assignedCases(profileName) {
  return CASES.filter((item) => item.assignedProfiles.includes(profileName)).map((item) => item.caseId);
}

module.exports = {
  AUTHORITY, REQUESTERS, REGISTRAR, CASES, RECORDS, MSP, certAttributes, assignedCases,
};
