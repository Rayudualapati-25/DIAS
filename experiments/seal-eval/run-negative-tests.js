#!/usr/bin/env node
'use strict';
/**
 * SEAL adversarial checks. Each attempts a specific abuse and records whether
 * the system refused it and with which error.
 */
const fs = require('fs');
const crypto = require('crypto');
const fabric = require('../../backend/src/fabric/gateway');
const { signAttestation } = require('../../backend/src/llm/policyAttestation');
const BASE = process.env.API_BASE || 'http://localhost:3001/api';

const results = [];
function rec(id, attempt, refused, detail) {
  results.push({ id, attempt, refused, detail });
  console.log(`  ${refused ? 'REFUSED ' : 'ACCEPTED'}  ${id}: ${attempt}`);
  if (detail) console.log(`             ${String(detail).slice(0, 150)}`);
}
async function api(method, p, { token, body } = {}) {
  const r = await fetch(`${BASE}${p}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function login(u) {
  const { json } = await api('POST', '/auth/login', { body: { username: u } });
  if (!json?.success) throw new Error(`login ${u}: ${json?.error}`);
  return json.data.token;
}

(async () => {
  console.log('\n=== ADVERSARIAL CHECKS ===\n');

  // N1 — authorization reuse by a different requester
  const shar = await login('insp.sharma');
  const own = await api('POST', '/access/llm-request', { token: shar,
    body: {
      recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
      query: 'View the FIR for case CASE-2026-001 for investigation.',
    } });
  const decisionId = own.json?.data?.decisionId;
  if (decisionId && own.json.data.decision === 'allow') {
    const other = await login('io.krishnan');
    const steal = await api('GET', `/records/REC-FIR-001/metadata/${decisionId}`, { token: other });
    rec('N1', 'a second officer opens a record using an ALLOW issued to another requester',
      steal.status !== 200, `HTTP ${steal.status}: ${steal.json?.error}`);
    const self = await api('GET', `/records/REC-FIR-001/metadata/${decisionId}`, { token: shar });
    rec('N1b', 'the originating requester opens the record under the same decision (control)',
      self.status === 200, `HTTP ${self.status} (expected 200 — this one SHOULD succeed)`);
  } else {
    rec('N1', 'could not obtain an ALLOW decision to test reuse', false, own.json?.error);
  }

  // N2 — a non-AI organisation submits a model decision
  const req2 = await fabric.submitWithTransient('police', 'insp.sharma', 'AccessContract',
    'CreateAccessRequest', ['REC-FIR-001', '{}'],
    { query: Buffer.from('probe for adversarial check N2', 'utf8') }, fabric.ACCESS_QUERY_ENDORSERS);
  try {
    await fabric.evaluate('police', 'insp.sharma', 'AccessContract',
      'GetAccessRequestForDecision', req2.requestId);
    rec('N2', 'a police identity reads the AI-only decision context', false, 'call succeeded');
  } catch (e) {
    rec('N2', 'a police identity reads the AI-only decision context', true, e.message);
  }
  try {
    await fabric.submit('police', 'insp.sharma', 'AccessContract', 'SubmitLLMDecision',
      req2.requestId, '{}', '{}', 'x'.repeat(86) + '==');
    rec('N3', 'a police identity submits a model decision', false, 'call succeeded');
  } catch (e) {
    rec('N3', 'a police identity submits a model decision', true, e.message);
  }

  // N4 — the AI operator submits a decision with a corrupted attestation
  const ctx = await fabric.evaluate('ai', 'llm-decider', 'AccessContract',
    'GetAccessRequestForDecision', req2.requestId).catch(() => null);
  if (ctx && ctx.status === 'requested') {
    const policyDecision = require('../../backend/src/llm/policyDecision');
    const mr = await policyDecision.decide({ query: ctx.query, subject: ctx.snapshot.subject,
      record: ctx.snapshot.record, requestContext: ctx.snapshot.requestContext || {} });
    const good = signAttestation({ queryHash: ctx.queryHash, contextHash: ctx.contextHash,
      decision: mr.decision, inference: mr.inference });
    // flip one base64 character
    const bad = (good[0] === 'A' ? 'B' : 'A') + good.slice(1);
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        req2.requestId, JSON.stringify(mr.decision), JSON.stringify(mr.inference), bad);
      rec('N4', 'the AI operator submits a decision under a corrupted attestation', false, 'call succeeded');
    } catch (e) {
      rec('N4', 'the AI operator submits a decision under a corrupted attestation', true, e.message);
    }
    // N5 — attestation from a key that is not the registered one
    const foreign = crypto.generateKeyPairSync('ed25519');
    const wrongKeySig = signAttestation(
      { queryHash: ctx.queryHash, contextHash: ctx.contextHash, decision: mr.decision, inference: mr.inference },
      { privateKeyPem: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        req2.requestId, JSON.stringify(mr.decision), JSON.stringify(mr.inference), wrongKeySig);
      rec('N5', 'a decision signed by an unregistered key is submitted', false, 'call succeeded');
    } catch (e) {
      rec('N5', 'a decision signed by an unregistered key is submitted', true, e.message);
    }
    // N6 — tamper the decision after signing (output commitment must break)
    const tampered = { ...mr.decision, decision: 'allow', reasonCode: 'POLICY_SATISFIED' };
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        req2.requestId, JSON.stringify(tampered), JSON.stringify(mr.inference), good);
      rec('N6', 'the decision payload is altered after the attestation was produced', false, 'call succeeded');
    } catch (e) {
      rec('N6', 'the decision payload is altered after the attestation was produced', true, e.message);
    }
    // N7 — legitimate submission then replay
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        req2.requestId, JSON.stringify(mr.decision), JSON.stringify(mr.inference), good);
      rec('N7a', 'a correctly attested decision is accepted (control)', true, 'accepted as expected');
      try {
        await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
          req2.requestId, JSON.stringify(mr.decision), JSON.stringify(mr.inference), good);
        rec('N7b', 'a second decision is submitted for the same request (replay)', false, 'call succeeded');
      } catch (e) {
        rec('N7b', 'a second decision is submitted for the same request (replay)', true, e.message);
      }
    } catch (e) {
      rec('N7a', 'a correctly attested decision is accepted (control)', false, e.message);
    }
  } else {
    rec('N4-N7', 'AI context unavailable (request already answered by the live service)', false,
      ctx ? `status=${ctx.status}` : 'no context');
  }

  fs.writeFileSync('experiments/seal-eval/negative-results.json',
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  const refused = results.filter((r) => r.refused).length;
  console.log(`\n${refused}/${results.length} checks behaved as intended\n`);
  process.exit(0);
})().catch((e) => { console.error('negative harness failed:', e.message); process.exit(1); });
