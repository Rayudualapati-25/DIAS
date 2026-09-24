#!/usr/bin/env node
'use strict';

/** Synthetic records supporting the documented policy scenarios. */

const fabric = require('../backend/src/fabric/gateway');
const vault = require('../backend/src/storage/vault');

const RECORDS = [
  {
    recordId: 'REC-FIR-001',
    payload: { synthetic: true, summary: 'Synthetic investigation record', complainantRef: 'DEMO-C-001' },
    meta: {
      caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'medium',
      juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
      owningStation: 'PS-Central', jurisdiction: 'district-north',
    },
  },
  {
    recordId: 'REC-EVIDENCE-001',
    payload: { synthetic: true, evidenceSummary: 'Synthetic forensic exhibit', victimAddress: 'REDACTED-DEMO' },
    meta: {
      caseId: 'CASE-2026-001', recordType: 'evidence', sensitivityLevel: 'medium',
      juvenileFlag: false, witnessFlag: false, victimProtectionFlag: true,
      owningStation: 'PS-Central', jurisdiction: 'district-north',
    },
  },
  {
    recordId: 'REC-JUVENILE-001',
    payload: { synthetic: true, summary: 'Synthetic juvenile-protected record' },
    meta: {
      caseId: 'CASE-2026-002', recordType: 'fir', sensitivityLevel: 'high',
      juvenileFlag: true, witnessFlag: false, victimProtectionFlag: false,
      owningStation: 'PS-Central', jurisdiction: 'district-north',
    },
  },
];

async function exists(recordId) {
  try {
    await fabric.evaluate('police', 'insp.sharma', 'RecordContract', 'GetRecord', recordId);
    return true;
  } catch (err) {
    if (String(err.message || err).includes('does not exist')) return false;
    throw err;
  }
}

async function main() {
  for (const item of RECORDS) {
    if (await exists(item.recordId)) {
      console.log(`skip      ${item.recordId}: already on the ledger`);
      continue;
    }
    const commitment = vault.save('police', item.recordId, item.payload);
    try {
      await fabric.submit(
        'police', 'insp.sharma', 'RecordContract', 'CreateCaseRecord', item.recordId,
        JSON.stringify({
          ...item.meta,
          owningAgency: 'police', status: 'active',
          contentHash: commitment.contentHash,
          offChainReference: commitment.offChainReference,
        })
      );
      console.log(`on-chain  ${item.recordId}`);
    } catch (err) {
      if (commitment.created) vault.rollback(commitment.offChainReference);
      throw err;
    }
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`record seed failed: ${err.message || err}`);
  process.exit(1);
});
