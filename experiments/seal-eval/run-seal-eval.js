#!/usr/bin/env node
'use strict';
/**
 * SEAL evaluation harness.
 * Drives the live API as real officers and reads the ledger back.
 * Emits raw per-trial data; no statistics are computed here.
 */
const fs = require('fs');
const path = require('path');
const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const N = Number(process.env.SEAL_TRIALS || 30);

async function api(method, p, { token, body } = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, json: j };
}
async function login(u) {
  const { json } = await api('POST', '/auth/login', { body: { username: u } });
  if (!json?.success) throw new Error(`login ${u}: ${json?.error}`);
  return json.data.token;
}
async function request(token, recordId, query) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const t0 = Date.now();
    try {
      const r = await api('POST', '/access/llm-request', {
        token, body: { recordId, action: 'view', purpose: 'investigation', query },
      });
      return { elapsedMs: Date.now() - t0, status: r.status, data: r.json?.data, error: r.json?.error };
    } catch (e) {
      if (attempt === 2) return { elapsedMs: Date.now() - t0, status: 0, error: `transport: ${e.message}` };
      await new Promise((r2) => setTimeout(r2, 2000));
    }
  }
}
function persist() {
  fs.mkdirSync('experiments/seal-eval', { recursive: true });
  fs.writeFileSync('experiments/seal-eval/results.json', JSON.stringify(out, null, 2));
}

const out = { startedAt: new Date().toISOString(), scenarios: [], latency: [], negative: [] };

async function scenario(name, user, recordId, query) {
  const token = await login(user);
  const r = await request(token, recordId, query);
  const d = r.data || {};
  const rec = {
    name, user, recordId, query,
    httpStatus: r.status,
    decision: d.decision, reasonCode: d.explanation?.reasonCode,
    decisionAuthority: d.decisionAuthority,
    subject: d.subject ? { mspId: d.subject.mspId, role: d.subject.role,
      jurisdiction: d.subject.jurisdiction, clearance: d.subject.clearance } : null,
    decidedByMsp: d.decidedByMsp,
    attestationPresent: Boolean(d.modelAttestation?.signature),
    publicKeyHash: d.modelAttestation?.publicKeyHash,
    decisiveAttributes: d.explanation?.decisiveAttributes,
    counterfactual: d.explanation?.counterfactual,
    explanationText: d.explanation?.text,
    modelVersion: d.explanation?.modelVersion, policyVersion: d.explanation?.policyVersion,
    inferenceMs: d.inference?.latencyMs, status: d.status,
    requestId: d.requestId, decisionId: d.decisionId,
    e2eMs: r.elapsedMs, error: r.error,
  };
  out.scenarios.push(rec);
  persist();
  console.log(`  [${name}] ${user} -> ${recordId} : ${String(rec.decision).toUpperCase()} / ${rec.reasonCode} (${rec.e2eMs} ms)`);
  return rec;
}

(async () => {
  console.log('\n=== A. FUNCTIONAL SCENARIOS ===');
  await scenario('ALLOW', 'insp.sharma', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 as part of my investigation.');
  await scenario('DENY', 'const.verma', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 for investigation.');
  await scenario('DISAGREEMENT', 'insp.singh', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 for my investigation.');

  // ESCALATE requires a sealed record; seal, test, restore.
  const jt = await login('judge.rana');
  const sealed = await api('POST', '/records/REC-EVIDENCE-001/seal', { token: jt });
  console.log(`  (sealed REC-EVIDENCE-001: HTTP ${sealed.status})`);
  await scenario('ESCALATE-sealed', 'insp.sharma', 'REC-EVIDENCE-001',
    'I need to view the sealed evidence record for case CASE-2026-001 for my investigation.');

  console.log('\n=== B. HUMAN REVIEW OF THE ESCALATED REQUEST ===');
  const escRec = out.scenarios.find((s) => s.name === 'ESCALATE-sealed');
  if (escRec?.decisionId) {
    const rt = await login('judge.rana');
    const pend = await api('GET', '/access/pending', { token: rt });
    const visible = Array.isArray(pend.json?.data)
      && pend.json.data.some((d) => d.decisionId === escRec.decisionId);
    const res = await api('POST', `/access/REC-EVIDENCE-001/${escRec.decisionId}/approve`,
      { token: rt, body: { note: 'court authorises opening of the sealed record' } });
    out.review = {
      reviewerVisible: visible, approveStatus: res.status,
      finalStatus: res.json?.data?.status,
      resolutionBy: res.json?.data?.resolution
        ? { msp: res.json.data.resolution.byMsp, role: res.json.data.resolution.byRole }
        : null,
      explanationRetained: Boolean(res.json?.data?.explanation?.reasonCode),
    };
    console.log(`  pending visible to reviewer: ${visible}`);
    console.log(`  approve -> HTTP ${res.status}, status=${out.review.finalStatus}, by=${JSON.stringify(out.review.resolutionBy)}`);
  }
  const unsealed = await api('POST', '/records/REC-EVIDENCE-001/unseal', { token: jt });
  console.log(`  (unsealed REC-EVIDENCE-001: HTTP ${unsealed.status})`);

  console.log(`\n=== C. LATENCY, N=${N} REPETITIONS (ALLOW path) ===`);
  const lt = await login('insp.sharma');
  for (let i = 0; i < N; i += 1) {
    const r = await request(lt, 'REC-FIR-001',
      `Investigation query ${i}: I need to view the first information report for case CASE-2026-001.`);
    if (r.status === 201 && r.data) {
      out.latency.push({ i, e2eMs: r.elapsedMs, inferenceMs: r.data.inference?.latencyMs,
        decision: r.data.decision, reasonCode: r.data.explanation?.reasonCode });
      persist();
      console.log(`  ${i + 1}/${N} e2e=${r.elapsedMs}ms inf=${r.data.inference?.latencyMs}ms`);
    } else {
      out.latency.push({ i, error: r.error, status: r.status });
      process.stdout.write(`  ${i + 1}/${N} FAILED (${r.status})\n`);
    }
  }
  console.log('');

  fs.mkdirSync(path.dirname(process.env.SEAL_OUT || 'experiments/seal-eval/results.json'), { recursive: true });
  fs.writeFileSync(process.env.SEAL_OUT || 'experiments/seal-eval/results.json', JSON.stringify(out, null, 2));
  console.log(`\nraw results -> ${process.env.SEAL_OUT || 'experiments/seal-eval/results.json'}`);
  process.exit(0);
})().catch((e) => { console.error('harness failed:', e.message); process.exit(1); });
