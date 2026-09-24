#!/usr/bin/env node
'use strict';

/**
 * Exactly three genuine SEAL acceptance scenarios against the live API, real
 * Qwen service, and real Fabric network. Development/debug runs belong in a
 * different output file; a successful output always contains ALLOW, DENY, and
 * ESCALATE once each.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const fabric = require('../backend/src/fabric/gateway');
const { canonicalize, hashObject } = require('../chaincode/crimerecords/lib/util/validate');
const {
  deriveEffectiveClassification, materializeDecision,
} = require('../chaincode/crimerecords/lib/policy/controlledDecision');

const BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api';

function args() {
  const result = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    result[process.argv[index].replace(/^--/, '')] = process.argv[index + 1];
  }
  if (!result.output) throw new Error('--output is required');
  return result;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, route, { token, body } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json };
}

async function apiBytes(method, route, token) {
  const response = await fetch(`${BASE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function login(username) {
  const response = await api('POST', '/auth/login', { body: { username } });
  requireCondition(response.status === 200 && response.json?.success,
    `login failed for ${username}: ${response.json?.error || response.status}`);
  return response.json.data.token;
}

async function createRecord(token, recordId) {
  const response = await api('POST', '/records', {
    token,
    body: {
      recordId,
      payload: { synthetic: true, researchRun: recordId },
      meta: {
        caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'medium',
        juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
        owningStation: 'PS-Central', jurisdiction: 'district-north',
      },
    },
  });
  requireCondition(response.status === 201,
    `record creation failed for ${recordId}: ${JSON.stringify(response.json)}`);
  return response.json.data;
}

async function requestDecision(token, recordId, query, action = 'view', purpose = 'investigation') {
  const started = Date.now();
  const response = await api('POST', '/access/llm-request', {
    token, body: { recordId, action, purpose, query },
  });
  requireCondition(response.status === 201,
    `LLM request failed for ${recordId}: ${JSON.stringify(response.json)}`);
  return { decision: response.json.data, roundTripMs: Date.now() - started };
}

function attestedDecision(decision, request) {
  const derived = deriveEffectiveClassification(
    decision.inference.modelClassification, request.snapshot
  );
  return {
    derived,
    decision: materializeDecision(derived.effective, request.snapshot),
  };
}

function verifyAttestation(decision, request, registration) {
  const rebuilt = attestedDecision(decision, request);
  const payload = {
    queryHash: request.queryHash,
    contextHash: request.contextHash,
    decision: rebuilt.decision,
    inference: decision.inference,
  };
  const signatureValid = crypto.verify(
    null,
    Buffer.from(canonicalize(payload), 'utf8'),
    crypto.createPublicKey(registration.publicKeyPem),
    Buffer.from(decision.modelAttestation.signature, 'base64')
  );
  const outputHashValid = decision.inference.outputHash === hashObject(rebuilt.decision);
  const registrationMatches = decision.inference.modelVersion === registration.modelVersion
    && decision.inference.adapterHash === registration.adapterHash
    && decision.modelAttestation.publicKeyHash === registration.publicKeyHash;
  return {
    valid: signatureValid && outputHashValid && registrationMatches,
    signatureValid,
    outputHashValid,
    registrationMatches,
    publicKeyHash: registration.publicKeyHash,
  };
}

async function capture(name, expected, requester, query, decisionResult, token, registration) {
  const decision = decisionResult.decision;
  const stored = await api('GET', `/access/request/${decision.requestId}`, { token });
  requireCondition(stored.status === 200, `cannot read request ${decision.requestId}`);
  const request = stored.json.data;
  const attestation = verifyAttestation(decision, request, registration);
  requireCondition(attestation.valid, `${name}: local attestation verification failed`);
  requireCondition(decision.decision === expected.decision,
    `${name}: expected ${expected.decision}, received ${decision.decision}`);
  requireCondition(decision.explanation.reasonCode === expected.reasonCode,
    `${name}: expected ${expected.reasonCode}, received ${decision.explanation.reasonCode}`);
  requireCondition(decision.policyValidation?.decision === expected.policyDecision,
    `${name}: unexpected deterministic policy decision`);
  requireCondition(decision.policyValidation?.reasonCode === expected.policyReason,
    `${name}: unexpected deterministic policy reason`);
  return {
    test: name,
    expected: expected.decision,
    naturalLanguageRequest: query,
    authenticatedRequester: requester,
    targetRecord: decision.recordId,
    trustedContext: request.snapshot,
    queryHash: request.queryHash,
    contextHash: request.contextHash,
    modelInterpretation: decision.inference.modelClassification,
    deterministicPolicy: decision.policyValidation,
    finalDecision: decision.decision,
    reasonCode: decision.explanation.reasonCode,
    structuredExplanation: decision.explanation,
    modelPolicyAgreement: decision.policyValidation.modelPolicyAgreement,
    attestation,
    fabric: {
      requestTransactionId: request.txId,
      decisionTransactionId: decision.decisionId,
      decidedByMsp: decision.decidedByMsp,
      decisionAuthority: decision.decisionAuthority,
      state: decision.status,
    },
    latency: {
      inferenceMs: decision.inference.latencyMs,
      apiRoundTripMs: decisionResult.roundTripMs,
    },
  };
}

async function main() {
  const options = args();
  const output = path.resolve(options.output);
  if (fs.existsSync(output)) throw new Error(`output exists: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const health = await api('GET', '/health');
  requireCondition(health.status === 200, 'backend is not healthy');
  const modelHealth = await fetch('http://127.0.0.1:8080/v1/models');
  requireCondition(modelHealth.ok, 'Qwen model server is not healthy');
  const registration = await fabric.evaluate(
    'audit', 'sp.north', 'PolicyContract', 'GetActiveLLMPolicyModel'
  );
  requireCondition(registration?.status === 'active', 'no active model registration');

  const tokens = {
    owner: await login('insp.sharma'),
    requester: await login('io.krishnan'),
    denied: await login('insp.rathore'),
    auditor: await login('sp.north'),
  };
  // Use the repository's normal opaque record-id form. This tests the policy
  // task without adding semantic words such as ALLOW/DENY to an identifier.
  const openRecord = `REC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const reviewRecord = `REC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  await createRecord(tokens.owner, openRecord);
  await createRecord(tokens.owner, reviewRecord);

  const tests = [];

  const allowQuery = `View record ${openRecord} for investigation.`;
  const allowResult = await requestDecision(tokens.requester, openRecord, allowQuery);
  const allow = await capture('Allow', {
    decision: 'allow', reasonCode: 'POLICY_SATISFIED',
    policyDecision: 'allow', policyReason: 'POLICY_SATISFIED',
  }, 'io.krishnan', allowQuery, allowResult, tokens.requester, registration);
  const metadata = await api(
    'GET', `/records/${openRecord}/metadata/${allowResult.decision.decisionId}`,
    { token: tokens.requester }
  );
  requireCondition(metadata.status === 200 && metadata.json.data.recordId === openRecord,
    'ALLOW did not release requester-bound metadata');
  const documentRequest = await api('POST', `/records/${openRecord}/document-requests`, {
    token: tokens.requester, body: { decisionId: allowResult.decision.decisionId },
  });
  requireCondition(documentRequest.status === 201, 'full-document request was not created');
  const pdf = Buffer.from('%PDF-1.4\n% SEAL final end-to-end verification\n%%EOF\n', 'utf8');
  const upload = await api(
    'POST', `/records/document-requests/${documentRequest.json.data.requestId}/upload`, {
      token: tokens.owner,
      body: {
        fileName: `${openRecord}.pdf`, mimeType: 'application/pdf',
        dataBase64: pdf.toString('base64'),
      },
    }
  );
  requireCondition(upload.status === 200, `owner upload failed: ${JSON.stringify(upload.json)}`);
  const release = await apiBytes(
    'GET', `/records/document-requests/${documentRequest.json.data.requestId}/content`,
    tokens.requester
  );
  requireCondition(release.status === 200 && release.bytes.equals(pdf),
    'requester-bound off-chain PDF release failed');
  allow.protectedWorkflow = {
    metadataReleased: true,
    documentRequestId: documentRequest.json.data.requestId,
    ownerUploadMsp: upload.json.data.ownerMsp,
    pdfHash: upload.json.data.contentHash,
    pdfReleasedToRequester: true,
  };
  tests.push(allow);

  const denyQuery = `Please let me view ${openRecord} for the investigation.`;
  const denyResult = await requestDecision(tokens.denied, openRecord, denyQuery);
  const deny = await capture('Deny', {
    decision: 'deny', reasonCode: 'CRED_NOT_ACTIVE',
    policyDecision: 'deny', policyReason: 'CRED_NOT_ACTIVE',
  }, 'insp.rathore', denyQuery, denyResult, tokens.denied, registration);
  const deniedMetadata = await api(
    'GET', `/records/${openRecord}/metadata/${denyResult.decision.decisionId}`,
    { token: tokens.denied }
  );
  requireCondition(deniedMetadata.status !== 200, 'DENY incorrectly released metadata');
  deny.protectedWorkflow = { metadataReleased: false, responseStatus: deniedMetadata.status };
  tests.push(deny);

  // The canonical request is view/investigation, while the private sentence says
  // export/prosecution. Qwen must interpret the sentence; the deterministic
  // input guard then turns the conflict into an AuditMSP-reviewed escalation.
  const escalateQuery = `Export ${reviewRecord} for prosecution.`;
  const escalateResult = await requestDecision(
    tokens.requester, reviewRecord, escalateQuery, 'view', 'investigation'
  );
  const escalate = await capture('Escalate', {
    decision: 'escalate', reasonCode: 'MODEL_INPUT_DISAGREEMENT',
    policyDecision: 'allow', policyReason: 'POLICY_SATISFIED',
  }, 'io.krishnan', escalateQuery, escalateResult, tokens.requester, registration);
  requireCondition(escalateResult.decision.decisionAuthority === 'canonical-input-escalation',
    'input disagreement did not use the canonical-input safety authority');
  requireCondition(escalateResult.decision.policyValidation?.modelInputAgreement === false,
    'test did not produce a genuine model/request input disagreement');
  const beforeReview = await api(
    'GET', `/records/${reviewRecord}/metadata/${escalateResult.decision.decisionId}`,
    { token: tokens.requester }
  );
  requireCondition(beforeReview.status === 422,
    'pending escalation incorrectly released metadata before auditor review');
  const reviewed = await api(
    'POST', `/access/${reviewRecord}/${escalateResult.decision.decisionId}/approve`, {
      token: tokens.auditor,
      body: { note: 'AuditMSP reviewed the interpretation conflict and approved access.' },
    }
  );
  requireCondition(reviewed.status === 200
      && reviewed.json.data.status === 'approved-after-escalation',
  `court review failed: ${JSON.stringify(reviewed.json)}`);
  const finalRequest = await api(
    'GET', `/access/request/${escalateResult.decision.requestId}`,
    { token: tokens.requester }
  );
  const reviewedMetadata = await api(
    'GET', `/records/${reviewRecord}/metadata/${escalateResult.decision.decisionId}`,
    { token: tokens.requester }
  );
  requireCondition(finalRequest.json.data.status === 'approved-after-escalation',
    'review did not update the request state');
  requireCondition(reviewedMetadata.status === 200,
    'approved escalation did not release requester-bound metadata');
  escalate.fabric.initialState = escalate.fabric.state;
  escalate.fabric.state = reviewed.json.data.status;
  escalate.humanReview = {
    completed: true,
    reviewerMsp: reviewed.json.data.resolution.byMsp,
    reviewerRole: reviewed.json.data.resolution.byRole,
    resolutionTransactionId: reviewed.json.data.resolution.resolutionTxId,
    finalRequestState: finalRequest.json.data.status,
    metadataReleasedAfterReview: true,
  };
  tests.push(escalate);

  requireCondition(tests.length === 3, 'acceptance output must contain exactly three tests');
  requireCondition(tests.map((test) => test.finalDecision).join(',') === 'allow,deny,escalate',
    'acceptance output must be ordered ALLOW, DENY, ESCALATE');
  const report = {
    runId: path.basename(output, path.extname(output)),
    startedFrom: { api: BASE, modelEndpoint: 'http://127.0.0.1:8080/v1' },
    finishedAtUtc: new Date().toISOString(),
    modelRegistration: {
      modelVersion: registration.modelVersion,
      adapterHash: registration.adapterHash,
      publicKeyHash: registration.publicKeyHash,
      activationTxId: registration.activationTxId,
      status: registration.status,
    },
    tests,
    summary: { total: 3, passed: 3, decisions: ['allow', 'deny', 'escalate'] },
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report.summary));
  console.log(output);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
