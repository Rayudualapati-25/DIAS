#!/usr/bin/env node
'use strict';

/** Write the seeded department identities onto the ledger. */

const users = require('../backend/src/fabric/users');
const ca = require('../backend/src/fabric/ca');

// The roster must stay in step with network/scripts/seed-identities.sh: the role here is the account's
// role, the role there is signed into the certificate, and UserContract will happily store a mismatch that
// then fails every access check.
const BOOTSTRAP = Object.freeze({ org: 'audit', user: 'Admin' });
const REGISTRAR = Object.freeze({
  police: 'sp.north',
  forensics: 'cfo.north',
  prosecution: 'dp.north',
  court: 'dj.north',
  audit: 'sp.north',
});

/**
 * The authority organisation, admitted first. A district head must exist before anybody else can be
 * created, because only a district head may admit a user.
 */
const AUTHORITY_ROSTER = [
  ['sp.north', 'audit', 'SP (district-north)', 'sp', 'active'],
  ['sp.south', 'audit', 'SP (district-south)', 'sp', 'active'],
  ['cfo.north', 'audit', 'Chief Forensic Officer (district-north)', 'chief-forensic-officer', 'active'],
  ['dp.north', 'audit', 'Director of Prosecution (district-north)', 'director-of-prosecution', 'active'],
  ['dj.north', 'audit', 'District Judge (district-north)', 'district-judge', 'active'],
  ['ci.central', 'audit', 'Circle Inspector (PS-Central)', 'circle-inspector', 'active'],
  ['ci.east', 'audit', 'Circle Inspector (PS-East)', 'circle-inspector', 'active'],
  ['ci.south', 'audit', 'Circle Inspector (PS-South)', 'circle-inspector', 'active'],
];

const ROSTER = [
  // [username, org, displayName, role, credentialStatus]
  ['sho.reddy', 'police', 'Insp. K. Reddy (station head, PS-Central)', 'inspector', 'active'],
  ['insp.sharma', 'police', 'Insp. A. Sharma', 'inspector', 'active'],
  ['const.verma', 'police', 'Const. R. Verma', 'constable', 'active'],
  ['io.krishnan', 'police', 'IO S. Krishnan', 'investigating-officer', 'active'],
  // Deliberately an ACTIVE account despite the name.
  ['insp.rathore', 'police', 'Insp. V. Rathore (revoked credential)', 'inspector', 'active'],
  ['insp.singh', 'police', 'Insp. P. Singh (cross-district)', 'inspector', 'active'],
  ['dir.iyer', 'forensics', 'Dir. M. Iyer', 'lab-director', 'active'],
  ['analyst.rao', 'forensics', 'Analyst P. Rao', 'lab-analyst', 'active'],
  ['pp.mehta', 'prosecution', 'PP D. Mehta', 'public-prosecutor', 'active'],
  ['dc.nair', 'prosecution', 'Adv. L. Nair', 'defense-counsel', 'active'],
  ['judge.rana', 'court', 'Hon. Justice Rana', 'judge', 'active'],
  ['clerk.das', 'court', 'Clerk B. Das', 'court-clerk', 'active'],
];

// Must mirror the ecert attributes in network/scripts/seed-identities.sh.
const USER_CONTEXT = Object.freeze({
  'sho.reddy': { rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high' },
  'insp.sharma': { rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', caseAssignments: ['CASE-2026-001', 'CASE-2026-002'] },
  'const.verma': { rank: '1', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'low' },
  'io.krishnan': { rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', caseAssignments: ['CASE-2026-001'] },
  'insp.rathore': { rank: '3', station: 'PS-East', jurisdiction: 'district-north', clearance: 'high', caseAssignments: ['CASE-2026-001'] },
  'insp.singh': { rank: '3', station: 'PS-South', jurisdiction: 'district-south', clearance: 'high', caseAssignments: ['CASE-2026-001'] },
  'dir.iyer': { station: 'FSL-North', jurisdiction: 'district-north', clearance: 'high' },
  'analyst.rao': { station: 'FSL-North', jurisdiction: 'district-north', clearance: 'medium', caseAssignments: ['CASE-2026-001'] },
  'pp.mehta': { jurisdiction: 'district-north', clearance: 'high' },
  'dc.nair': { jurisdiction: 'district-north', clearance: 'low' },
  'judge.rana': { jurisdiction: 'district-north', clearance: 'high' },
  'clerk.das': { jurisdiction: 'district-north', clearance: 'low' },
  // Authority body. Station heads carry a station; district heads do not. ci.east deliberately holds only
  // medium clearance, so a request for a high-sensitivity record at PS-East passes him and reaches the
  // district head.
  'sp.north': { jurisdiction: 'district-north', clearance: 'high' },
  'sp.south': { jurisdiction: 'district-south', clearance: 'high' },
  'cfo.north': { jurisdiction: 'district-north', clearance: 'high' },
  'dp.north': { jurisdiction: 'district-north', clearance: 'high' },
  'dj.north': { jurisdiction: 'district-north', clearance: 'high' },
  'ci.central': { station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high' },
  'ci.east': { station: 'PS-East', jurisdiction: 'district-north', clearance: 'medium' },
  'ci.south': { station: 'PS-South', jurisdiction: 'district-south', clearance: 'high' },
});

/** The real reason a transaction failed. */
function chaincodeMessage(error) {
  const parts = [String(error.message || error)];
  for (const detail of error.details || []) {
    if (detail && detail.message) parts.push(String(detail.message));
  }
  return parts.join(' | ');
}

const blue = (s) => `[0;34m${s}[0m`;
const red = (s) => `[0;31m${s}[0m`;

async function main() {
  const everyone = [...AUTHORITY_ROSTER, ...ROSTER];
  const missing = everyone
    .filter(([username, org]) => !ca.isEnrolled(org, username))
    .map(([username, org]) => `${org}/${username}`);
  if (missing.length > 0) {
    console.error(red('These identities are not enrolled yet:'));
    missing.forEach((m) => console.error(`  ${m}`));
    console.error('\nRun `make seed` first — it registers and enrols them with the CAs.');
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;

  // The first authority identity is admitted by the CA administrator through the genesis bootstrap; from
  // the second onwards a district head is already in place.
  let bootstrapped = false;
  try {
    const existing = await users.list(BOOTSTRAP.org, BOOTSTRAP.user);
    bootstrapped = Array.isArray(existing) && existing.length > 0;
    if (bootstrapped) {
      console.log(`ledger already holds ${existing.length} user(s); genesis bootstrap closed`);
    }
  } catch (_error) {
    // An unreadable ledger is treated as empty: the bootstrap attempt will say so.
  }
  for (const [index, entry] of everyone.entries()) {
    const [username, org, displayName, role, credentialStatus] = entry;
    const isFirst = index === 0 && !bootstrapped;
    const registrar = isFirst ? BOOTSTRAP.user : REGISTRAR[org];
    const registrarOrg = isFirst ? BOOTSTRAP.org : 'audit';
    try {
      await users.create(registrarOrg, registrar, username, {
        displayName,
        org,
        role,
        fabricUser: username,
        departmentId: org,
        ...USER_CONTEXT[username],
        caseAssignments: USER_CONTEXT[username].caseAssignments || [],
        credentialStatus,
      });
      console.log(blue(`on-chain  ${org}/${username}  (${role})`
        + `${isFirst ? '  [genesis bootstrap]' : ''}`));
      created += 1;
      bootstrapped = true;
    } catch (err) {
      const message = chaincodeMessage(err);
      if (message.includes('already exists')) {
        console.log(`skip      ${org}/${username}: already on the ledger`);
        skipped += 1;
        bootstrapped = true;
        continue;
      }
      console.error(red(`failed    ${org}/${username}: ${message}`));
      throw err;
    }
  }

  console.log(`\n${created} account(s) written to the ledger, ${skipped} already present.`);
  console.log('Open http://localhost:3001 and select any enrolled identity above.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(red(`\nSeeding failed: ${err.message || err}`));
    process.exit(1);
  });
