#!/usr/bin/env node
'use strict';

/** Submit a correctly signed but policy-inconsistent artifact to the live
 * chaincode. Success means Fabric rejects it independently of the AI service.
 * Stop the AI listener while this script runs; restart it afterwards so the
 * retained request is answered normally.
 */

const fs = require('fs');
const path = require('path');
const fabric = require('../backend/src/fabric/gateway');
const { signAttestation } = require('../backend/src/llm/policyAttestation');
const { hashObject } = require('../chaincode/crimerecords/lib/util/validate');
const { materializeDecision } = require('../chaincode/crimerecords/lib/policy/controlledDecision');

function outputPath() {
  const index = process.argv.indexOf('--output');
  if (index < 0 || !process.argv[index + 1]) throw new Error('--output is required');
  return path.resolve(process.argv[index + 1]);
}

async function main() {
  const output = outputPath();
  if (fs.existsSync(output)) throw new Error(`output exists: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const query = 'I need to view REC-FIR-001 for my assigned investigation.';
  const request = await fabric.submitWithTransient(
    'police', 'insp.sharma', 'AccessContract', 'CreateAccessRequest',
    ['REC-FIR-001', '{}'], { query: Buffer.from(query) }, fabric.ACCESS_QUERY_ENDORSERS
  );
  const context = await fabric.evaluate(
    'ai', 'llm-decider', 'AccessContract', 'GetAccessRequestForDecision', request.requestId
  );
  const registration = await fabric.evaluate(
    'audit', 'sp.north', 'PolicyContract', 'GetActiveLLMPolicyModel'
  );
  const advisory = {
    action: 'view', purpose: 'investigation', decision: 'deny',
    reasonCode: 'NOT_ASSIGNED', policyVersion: 'crime-policy-v2',
    modelVersion: registration.modelVersion,
  };
  // Structurally valid and signed, but unsafe: trusted state says this officer
  // is assigned and the deterministic result is POLICY_SATISFIED/ALLOW.
  const unsafeDecision = materializeDecision(advisory, context.snapshot);
  const inference = {
    adapterHash: registration.adapterHash,
    latencyMs: 1,
    modelClassification: advisory,
    modelVersion: registration.modelVersion,
    outputHash: hashObject(unsafeDecision),
    promptHash: 'f'.repeat(64),
    servedModel: 'mlx-community/Qwen3-14B-4bit',
  };
  const signature = signAttestation({
    queryHash: context.queryHash,
    contextHash: context.contextHash,
    decision: unsafeDecision,
    inference,
  });
  let error = null;
  try {
    await fabric.submit(
      'ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision', request.requestId,
      JSON.stringify(unsafeDecision), JSON.stringify(inference), signature
    );
  } catch (caught) {
    error = [caught.message, ...(caught.details || []).map((item) => item.message)]
      .filter(Boolean).join(' | ');
  }
  const rejected = Boolean(error && error.includes('independently derived policy result'));
  const artifact = {
    checkedAtUtc: new Date().toISOString(),
    requestId: request.requestId,
    queryHash: context.queryHash,
    modelClassification: advisory,
    submittedDecision: unsafeDecision.decision,
    submittedReason: unsafeDecision.reasonCode,
    signatureCreated: true,
    rejected,
    rejection: error,
  };
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  if (!rejected) throw new Error(`live guard rejection was not observed: ${error || 'accepted'}`);
  console.log(JSON.stringify({ requestId: request.requestId, rejected }));
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
