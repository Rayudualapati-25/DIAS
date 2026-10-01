#!/usr/bin/env node
'use strict';

/**
 * Seed the records of a reuse plan on the testbed ledger: the sibling cases
 * (copies of the world cases with the same assigned users) and one record per
 * stream (the base copy in the world case, the siblings in the sibling cases).
 * Same contract calls, identity and off-chain payload commitment as
 * testbed/seed/seed-ledger.js. Idempotent: anything already on the ledger is
 * skipped. Records are written ten at a time.
 *
 * Runs inside the dias-backend:testbed image with testbed/reuse mounted:
 *   node testbed/reuse/seed.js --plan testbed/reuse/generated/reuse-100-users-plan.json
 */

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const fabric = require(path.join(APP, 'backend/src/fabric/gateway'));
const vault = require(path.join(APP, 'backend/src/storage/vault'));

const CHUNK = 10;

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

async function seedCase({ caseId, body }) {
  return orSkip(`case ${caseId}`,
    () => fabric.submit('police', 'insp.sharma', 'GovernanceContract', 'CreateCase', caseId, JSON.stringify(body)));
}

async function seedRecord({ recordId, record }) {
  const payload = { synthetic: true, summary: `Synthetic ${record.recordType} record for ${record.caseId}`, recordId };
  const commitment = vault.save('police', recordId, payload);
  const outcome = await orSkip(`record ${recordId}`, () => fabric.submit(
    'police', 'insp.sharma', 'RecordContract', 'CreateCaseRecord', recordId,
    JSON.stringify({
      caseId: record.caseId,
      recordType: record.recordType,
      sensitivityLevel: record.sensitivityLevel,
      juvenileFlag: record.juvenileFlag,
      witnessFlag: record.witnessFlag,
      victimProtectionFlag: record.victimProtectionFlag,
      owningStation: record.owningStation,
      owningAgency: record.owningAgency,
      jurisdiction: record.jurisdiction,
      status: 'active',
      contentHash: commitment.contentHash,
      offChainReference: commitment.offChainReference,
    })
  ));
  if (outcome === 'skipped' && commitment.created) vault.rollback(commitment.offChainReference);
  return outcome;
}

async function main() {
  const planIndex = process.argv.indexOf('--plan');
  if (planIndex < 0) throw new Error('--plan is required');
  const plan = JSON.parse(fs.readFileSync(path.resolve(APP, process.argv[planIndex + 1]), 'utf8'));
  const tally = (outcomes) => ({
    created: outcomes.filter((o) => o === 'created').length,
    skipped: outcomes.filter((o) => o === 'skipped').length,
  });

  const caseOutcomes = [];
  for (const item of plan.siblingCases) caseOutcomes.push(await seedCase(item));
  console.log(`sibling cases: ${JSON.stringify(tally(caseOutcomes))} of ${plan.siblingCases.length}`);

  const recordOutcomes = [];
  for (let i = 0; i < plan.streams.length; i += CHUNK) {
    recordOutcomes.push(...await Promise.all(plan.streams.slice(i, i + CHUNK).map(seedRecord)));
  }
  console.log(`records: ${JSON.stringify(tally(recordOutcomes))} of ${plan.streams.length}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`reuse seed failed: ${error.message}`);
  process.exit(1);
});
