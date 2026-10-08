#!/usr/bin/env node
'use strict';

/**
 * Seed the testbed ledger through the DIAS chaincode, with the same contract
 * calls and identities the single-host seed scripts use:
 *  1. user accounts (genesis bootstrap by the Audit admin, then district heads
 *     admit everyone else), including the 100 load-test users;
 *  2. the five departments;
 *  3. the cases, with every clone of an assigned profile on the case;
 *  4. the case files, each with an off-chain payload commitment.
 * Idempotent: anything already on the ledger is skipped.
 *
 * Runs inside the dias-backend:testbed image on the diasnet overlay network.
 */

const path = require('path');
const fs = require('fs');

const APP = path.resolve(__dirname, '..', '..');
const fabric = require(path.join(APP, 'backend/src/fabric/gateway'));
const users = require(path.join(APP, 'backend/src/fabric/users'));
const vault = require(path.join(APP, 'backend/src/storage/vault'));
const world = require('./world');
const config = require('../../backend/src/config');
const { registerAndActivatePolicy } = require('../../backend/src/dias/policyRegistration');
const { registerRecommenderKey } = require('../../backend/src/dias/signerRegistration');
const { createRecommendationSigner } = require('../../backend/src/dias/recommendationSigner');

const LOAD_USERS = JSON.parse(fs.readFileSync(path.join(APP, 'testbed/load/generated/users.json'), 'utf8'));

function chaincodeMessage(error) {
  const parts = [String(error.message || error)];
  for (const detail of error.details || []) {
    if (detail && detail.message) parts.push(String(detail.message));
  }
  return parts.join(' | ');
}

async function orSkip(label, operation) {
  try {
    await operation();
    return 'created';
  } catch (error) {
    const message = chaincodeMessage(error);
    if (/already exists/i.test(message)) return 'skipped';
    throw new Error(`${label}: ${message}`);
  }
}

function profileFor(user) {
  const profile = {
    displayName: user.displayName,
    org: user.org,
    role: user.role,
    fabricUser: user.username,
    departmentId: user.org,
    jurisdiction: user.jurisdiction,
    clearance: user.clearance,
    caseAssignments: user.caseAssignments || [],
    credentialStatus: 'active',
  };
  if (user.rank) profile.rank = user.rank;
  if (user.station) profile.station = user.station;
  return profile;
}

async function seedUsers() {
  const everyone = [
    ...world.AUTHORITY.map((user) => ({ ...user, caseAssignments: [] })),
    ...world.REQUESTERS.map((user) => ({ ...user, caseAssignments: world.assignedCases(user.username) })),
    ...LOAD_USERS,
  ];
  let created = 0;
  let skipped = 0;
  for (const [index, user] of everyone.entries()) {
    // Genesis: only an Audit administrator may admit the very first user.
    const registrar = index === 0 ? { org: 'audit', user: 'Admin' } : { org: 'audit', user: world.REGISTRAR[user.org] };
    const outcome = await orSkip(`user ${user.username}`,
      () => users.create(registrar.org, registrar.user, user.username, profileFor(user)));
    if (outcome === 'created') created += 1; else skipped += 1;
  }
  console.log(`users: ${created} created, ${skipped} already present (total ${everyone.length})`);
}

const DEPARTMENTS = [
  ['police', 'sp.north', { name: 'Police Department', type: 'police', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['investigation', 'record-filing'] }],
  ['forensics', 'cfo.north', { name: 'Forensic Science Laboratory', type: 'forensics', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['forensic-analysis', 'evidence-review'] }],
  ['prosecution', 'dp.north', { name: 'Public Prosecution Department', type: 'prosecution', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['prosecution', 'case-review'] }],
  ['court', 'dj.north', { name: 'District Court', type: 'court', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['judicial-proceeding', 'record-sealing'] }],
  ['audit', 'sp.north', { name: 'Independent Oversight Office', type: 'oversight', jurisdiction: 'district-north', status: 'active', permittedFunctions: ['audit-review', 'ombudsman-review'] }],
];

async function seedDepartments() {
  for (const [org, registrar, profile] of DEPARTMENTS) {
    const outcome = await orSkip(`department ${org}`,
      () => fabric.submit('audit', registrar, 'GovernanceContract', 'CreateDepartment', org, JSON.stringify(profile)));
    console.log(`department ${org}: ${outcome}`);
  }
}

async function seedCases() {
  for (const item of world.CASES) {
    const assignedUsers = [
      ...item.assignedProfiles,
      ...LOAD_USERS.filter((user) => item.assignedProfiles.includes(user.profile)).map((user) => user.username),
    ];
    const body = {
      owningAgency: item.owningAgency,
      jurisdiction: item.jurisdiction,
      status: item.status,
      assignedUsers,
      protectedClassifications: item.protectedClassifications,
    };
    const outcome = await orSkip(`case ${item.caseId}`,
      () => fabric.submit('police', 'insp.sharma', 'GovernanceContract', 'CreateCase', item.caseId, JSON.stringify(body)));
    console.log(`case ${item.caseId}: ${outcome} (${assignedUsers.length} assigned users)`);
  }
}

async function seedRecords() {
  let created = 0;
  for (const record of world.RECORDS) {
    const { recordId, ...meta } = record;
    const payload = { synthetic: true, summary: `Synthetic ${meta.recordType} record for ${meta.caseId}`, recordId };
    const commitment = vault.save('police', recordId, payload);
    const outcome = await orSkip(`record ${recordId}`, () => fabric.submit(
      'police', 'insp.sharma', 'RecordContract', 'CreateCaseRecord', recordId,
      JSON.stringify({
        caseId: meta.caseId,
        recordType: meta.recordType,
        sensitivityLevel: meta.sensitivityLevel,
        juvenileFlag: meta.juvenileFlag,
        witnessFlag: meta.witnessFlag,
        victimProtectionFlag: meta.victimProtectionFlag,
        owningStation: meta.owningStation,
        owningAgency: meta.owningAgency,
        jurisdiction: meta.jurisdiction,
        status: 'active',
        contentHash: commitment.contentHash,
        offChainReference: commitment.offChainReference,
      })
    ));
    if (outcome === 'created') created += 1;
    else if (commitment.created) vault.rollback(commitment.offChainReference);
  }
  console.log(`records: ${created} created of ${world.RECORDS.length}`);
}

async function main() {
  // Load the existing operator-managed key before mutating the ledger. Never
  // replace it here: existing commitments must remain verifiable.
  const signer = createRecommendationSigner({ privateKeyPem:
    fs.readFileSync(config.DIAS_RECOMMENDER_SIGNING_KEY_FILE, 'utf8') });
  await seedUsers();
  await seedDepartments();
  const registrar = { org: 'audit', fabricUser: 'sp.north' };
  console.log('policy:', JSON.stringify(await registerAndActivatePolicy({ ledger: fabric, registrar,
    activator: { org: 'audit', fabricUser: 'cfo.north' }, bundlePath: config.DIAS_POLICY_BUNDLE_PATH })));
  console.log('recommendation signer:', JSON.stringify(await registerRecommenderKey({ ledger: fabric, registrar, signer })));
  await seedCases();
  await seedRecords();
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`seed failed: ${error.message}`);
  process.exit(1);
});
