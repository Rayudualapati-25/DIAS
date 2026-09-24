#!/usr/bin/env node
'use strict';

/**
 * Deterministic ledger seed for departments and the initial demo cases.
 *
 * Governance policy and model registration are NOT seeded here. In DIAS they are
 * separate governance acts with their own hashes and their own idempotence
 * rules, performed by scripts/dias/register-policy-and-model.js. Keeping them
 * apart means a policy change never rides along with a domain re-seed.
 */

const fabric = require('../backend/src/fabric/gateway');

const DEPARTMENTS = [
  ['police', 'sp.north', { name: 'Police Department', type: 'police', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['investigation', 'record-filing'] }],
  ['forensics', 'cfo.north', { name: 'Forensic Science Laboratory', type: 'forensics', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['forensic-analysis', 'evidence-review'] }],
  ['prosecution', 'dp.north', { name: 'Public Prosecution Department', type: 'prosecution', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['prosecution', 'case-review'] }],
  ['court', 'dj.north', { name: 'District Court', type: 'court', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['judicial-proceeding', 'record-sealing'] }],
  ['audit', 'sp.north', { name: 'Independent Oversight Office', type: 'oversight', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['audit-review', 'ombudsman-review'] }],
];

const CASES = [
  ['CASE-2026-001', {
    owningAgency: 'police', jurisdiction: 'district-north', status: 'under-investigation',
    assignedUsers: ['insp.sharma', 'io.krishnan'], protectedClassifications: [],
  }],
  ['CASE-2026-002', {
    owningAgency: 'police', jurisdiction: 'district-north', status: 'under-investigation',
    assignedUsers: ['insp.sharma'], protectedClassifications: ['juvenile'],
  }],
];

/**
 * The real reason a transaction failed. fabric-gateway reports a rejected
 * endorsement as a generic "10 ABORTED" and puts each peer's chaincode message in
 * `details`; reading only `message` turns an ordinary "already exists" into a
 * fatal error when re-seeding.
 */
function chaincodeMessage(error) {
  const parts = [String(error.message || error)];
  for (const detail of error.details || []) {
    if (detail && detail.message) parts.push(String(detail.message));
  }
  return parts.join(' | ');
}

async function submitOrSkip(org, user, contract, fn, ...args) {
  try {
    const result = await fabric.submit(org, user, contract, fn, ...args);
    console.log(`on-chain  ${fn} ${args[0]}`);
    return result;
  } catch (err) {
    const message = chaincodeMessage(err);
    if (message.includes('already exists')) {
      console.log(`skip      ${fn} ${args[0]}: already on the ledger`);
      return null;
    }
    throw err;
  }
}

async function main() {
  for (const [org, registrar, profile] of DEPARTMENTS) {
    await submitOrSkip(
      'audit', registrar, 'GovernanceContract', 'CreateDepartment', org, JSON.stringify(profile)
    );
  }
  for (const [caseId, profile] of CASES) {
    await submitOrSkip(
      'police', 'sho.reddy', 'GovernanceContract', 'CreateCase', caseId,
      JSON.stringify(profile)
    );
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`domain seed failed: ${err.message || err}`);
  process.exit(1);
});
