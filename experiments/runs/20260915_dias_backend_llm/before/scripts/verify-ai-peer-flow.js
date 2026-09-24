#!/usr/bin/env node
'use strict';

/**
 * End-to-end proof that the policy model is a network participant.
 *
 * Drives the real API as a real officer and then reads the ledger back, checking
 * the three things that make this an integration rather than two systems side by
 * side: the request and the decision are separate transactions, the decision is
 * signed by the AI organisation, and it describes the requester rather than the AI.
 */

const BASE = process.env.API_BASE || 'http://localhost:3001/api';

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: await response.json() };
}

async function login(username) {
  const { json } = await api('POST', '/auth/login', { body: { username } });
  if (!json.success) throw new Error(`login ${username}: ${json.error}`);
  return json.data.token;
}

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail });
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const recordId = process.env.VERIFY_RECORD_ID || 'REC-FIR-001';
  const who = process.env.VERIFY_USER || 'insp.sharma';
  console.log(`\n== ${who} requests ${recordId} ==\n`);

  const token = await login(who);
  const started = Date.now();
  const result = await api('POST', '/access/llm-request', {
    token,
    body: {
      recordId, action: 'view', purpose: 'investigation',
      query: `I need to view the metadata for record ${recordId} for investigation.`,
    },
  });
  const elapsed = Date.now() - started;
  if (result.status !== 201) {
    console.error(`request failed (${result.status}): ${result.json.error}`);
    process.exit(1);
  }
  const decision = result.json.data;
  console.log(`  decision: ${decision.decision.toUpperCase()} / ${decision.explanation.reasonCode}`
    + `  in ${elapsed} ms\n`);

  // 1. the model answered as itself, not as the officer who asked
  check('decision was signed by the AI organisation',
    decision.decidedByMsp === 'AIOrgMSP', `decidedByMsp=${decision.decidedByMsp}`);
  check('decision is attributed to a different identity than the requester',
    decision.decidedByIdentityHash && decision.decidedByIdentityHash !== decision.subject.identityHash);

  // 2. but it decided ABOUT the officer
  check('decision describes the requester, not the AI',
    decision.subject.mspId !== 'AIOrgMSP' && Boolean(decision.subject.role),
    `subject=${decision.subject.role} of ${decision.subject.mspId}`);

  // 3. request and decision are separate ledger entries
  const request = await api('GET', `/access/request/${decision.requestId}`, { token });
  const storedRequest = request.json.data;
  check('the request exists on the ledger as its own transaction',
    storedRequest && storedRequest.requestId === decision.requestId,
    storedRequest ? `requestId=${storedRequest.requestId}` : 'missing');
  check('the request and the decision have different transaction ids',
    storedRequest && storedRequest.txId !== decision.decisionId,
    storedRequest ? `request tx ${String(storedRequest.txId).slice(0, 10)} vs decision tx ${String(decision.decisionId).slice(0, 10)}` : '');

  // 4. the model was bound to the registered adapter
  check('the decision carries an attestation over the registered model',
    Boolean(decision.modelAttestation && decision.modelAttestation.signature),
    decision.modelAttestation ? `key ${decision.modelAttestation.publicKeyHash.slice(0, 12)}…` : '');
  check('real inference ran', Number(decision.inference?.latencyMs) > 0,
    `${decision.inference?.latencyMs} ms on ${decision.inference?.servedModel}`);

  // 5. an ALLOW actually opens the file for the requester
  if (decision.decision === 'allow') {
    const meta = await api('GET', `/records/${recordId}/metadata/${decision.decisionId}`, { token });
    check('the requester can open the file under that decision',
      meta.status === 200 && meta.json.data?.recordId === recordId);
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`verification failed: ${error.message}`);
  process.exit(1);
});
