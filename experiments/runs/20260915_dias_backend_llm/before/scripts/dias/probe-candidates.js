#!/usr/bin/env node
'use strict';

/**
 * Probe candidate requests to learn what the deployed model actually recommends.
 *
 * Scenario A needs a model ALLOW and scenario C needs a model DENY. Assuming
 * which candidate produces which would make the acceptance run a test of the
 * assumption rather than of the workflow, so the answers are observed first and
 * the scenarios are routed afterwards.
 *
 *   CHAINCODE=diasrecords node scripts/dias/probe-candidates.js
 */

const fs = require('fs');
const path = require('path');
const { submitAndAwait, review } = require('./live-scenarios');

/** Requests over the seeded world, chosen to span the policy's outcomes. */
const CANDIDATES = Object.freeze([
  {
    id: 'assigned-inspector-own-district',
    requester: { org: 'police', user: 'insp.sharma' },
    recordId: 'REC-FIR-001',
    body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
    justification: 'I am investigating CASE-2026-001 and need to read the FIR.',
    expectation: 'ALLOW: assigned, cleared, same district, ordinary record',
  },
  {
    id: 'cross-district-inspector',
    requester: { org: 'police', user: 'insp.singh' },
    recordId: 'REC-FIR-001',
    body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
    justification: 'I need the FIR for a related enquiry I am running.',
    expectation: 'DENY: requester is in district-south, record is district-north',
  },
  {
    id: 'constable-juvenile-record',
    requester: { org: 'police', user: 'const.verma' },
    recordId: 'REC-JUVENILE-001',
    body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
    justification: 'I have been asked to check this file.',
    expectation: 'DENY: juvenile record, low clearance against high sensitivity, unassigned',
  },
  {
    id: 'court-clerk-juvenile-record',
    requester: { org: 'court', user: 'clerk.das' },
    recordId: 'REC-JUVENILE-001',
    body: { action: 'view', purpose: 'judicial-proceeding', emergencyFlag: false },
    justification: 'Preparing the hearing bundle for the listed matter.',
    expectation: 'DENY: court-clerk is not juvenile-authorized and holds low clearance',
  },
  {
    id: 'assigned-io-evidence',
    requester: { org: 'police', user: 'io.krishnan' },
    recordId: 'REC-EVIDENCE-001',
    body: { action: 'view', purpose: 'investigation', emergencyFlag: false },
    justification: 'Reviewing the exhibits logged under CASE-2026-001.',
    expectation: 'ALLOW: assigned investigating officer, same district, medium sensitivity',
  },
]);

async function main() {
  const outDir = path.resolve(process.argv[3] || 'experiments/runs/20260912_dias_live_fabric');
  fs.mkdirSync(outDir, { recursive: true });
  const probes = [];
  for (const candidate of CANDIDATES) {
    process.stdout.write(`[probe] ${candidate.id} ... `);
    const request = await submitAndAwait(
      candidate.requester, candidate.recordId, candidate.body, candidate.justification);
    const detail = await review(request.requestId);
    const recommendation = detail.recommendation || {};
    probes.push({
      ...candidate,
      requestId: request.requestId,
      txId: request.txId,
      status: request.status,
      processingPath: request.processingPath,
      generationStatus: recommendation.generationStatus || null,
      recommendation: recommendation.recommendation || null,
      reasonCode: recommendation.reasonCode || null,
      policyRefs: recommendation.policyRefs || [],
      reviewFlags: recommendation.reviewFlags || [],
    });
    process.stdout.write(
      `${recommendation.generationStatus || '?'} ${recommendation.recommendation || '-'} `
      + `(${recommendation.reasonCode || '-'})  [${request.requestId}]\n`);
  }
  fs.writeFileSync(path.join(outDir, 'probes.json'), `${JSON.stringify(probes, null, 2)}\n`);
  console.log(`\nwritten to ${path.join(outDir, 'probes.json')}`);
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`[probe] ${error.stack || error.message}`);
  process.exit(1);
});
