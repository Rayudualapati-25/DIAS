#!/usr/bin/env node
'use strict';
/**
 * SEAL evaluation harness (gateway-driven).
 * Submits the request transaction directly, then polls the ledger for the
 * decision, so measurement is not bounded by the web client's timeout and is
 * not quantised by its 250 ms poll. Writes after every trial.
 */
const fs = require('fs');
const fabric = require('../../backend/src/fabric/gateway');
const N = Number(process.env.SEAL_TRIALS || 20);
const POLL = 100, TIMEOUT = 180000;

const out = { startedAt: new Date().toISOString(), scenarios: [], latency: [] };
const persist = () => fs.writeFileSync('experiments/seal-eval/results2.json', JSON.stringify(out, null, 2));

const USERS = {
  'insp.sharma': 'police', 'const.verma': 'police', 'insp.singh': 'police',
  'judge.rana': 'court', 'analyst.rao': 'forensics',
};

async function runOne(user, recordId, query) {
  const org = USERS[user];
  const tSubmit = Date.now();
  const req = await fabric.submitWithTransient(org, user, 'AccessContract',
    'CreateAccessRequest', [recordId, '{}'],
    { query: Buffer.from(query, 'utf8') }, fabric.ACCESS_QUERY_ENDORSERS);
  const requestMs = Date.now() - tSubmit;
  const tWait = Date.now();
  let decision = null, stored = null;
  while (Date.now() - tWait < TIMEOUT) {
    stored = await fabric.evaluate(org, user, 'AccessContract', 'GetRequest', req.requestId);
    if (stored.decisionId) {
      decision = await fabric.evaluate(org, user, 'AccessContract', 'GetDecision',
        recordId, stored.decisionId);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL));
  }
  const waitMs = Date.now() - tWait;
  return { requestId: req.requestId, requestMs, waitMs, totalMs: requestMs + waitMs,
    decision, requestStatus: stored?.status };
}

async function scenario(name, user, recordId, query) {
  let r;
  try { r = await runOne(user, recordId, query); }
  catch (e) { r = { error: e.message }; }
  const d = r.decision || {};
  const rec = { name, user, recordId, query, requestMs: r.requestMs, waitMs: r.waitMs,
    totalMs: r.totalMs, answered: Boolean(r.decision), requestStatus: r.requestStatus,
    decision: d.decision, reasonCode: d.explanation?.reasonCode,
    decisionAuthority: d.decisionAuthority, ledgerStatus: d.status,
    subject: d.subject ? { mspId: d.subject.mspId, role: d.subject.role,
      jurisdiction: d.subject.jurisdiction, clearance: d.subject.clearance } : null,
    decidedByMsp: d.decidedByMsp, attestation: Boolean(d.modelAttestation?.signature),
    decisiveAttributes: d.explanation?.decisiveAttributes,
    counterfactual: d.explanation?.counterfactual, explanationText: d.explanation?.text,
    inferenceMs: d.inference?.latencyMs, decisionId: d.decisionId, error: r.error };
  out.scenarios.push(rec); persist();
  console.log(`  [${name}] ${user} -> ${recordId}: ${r.decision ? String(d.decision).toUpperCase() + ' / ' + rec.reasonCode : 'UNANSWERED (' + rec.requestStatus + ')'}`
    + `  req=${r.requestMs}ms wait=${r.waitMs}ms inf=${rec.inferenceMs || '-'}ms`);
  return rec;
}

(async () => {
  console.log('\n=== A. FUNCTIONAL SCENARIOS ===');
  await scenario('ALLOW', 'insp.sharma', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 as part of my investigation.');
  await scenario('DENY', 'const.verma', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 for investigation.');
  await scenario('DENY-victim', 'analyst.rao', 'REC-EVIDENCE-001',
    'I need to view the raw evidence record for case CASE-2026-001 for forensic analysis.');
  await scenario('DISAGREEMENT', 'insp.singh', 'REC-FIR-001',
    'I need to view the first information report for case CASE-2026-001 for my investigation.');

  await fabric.submit('court', 'judge.rana', 'RecordContract', 'SealRecord', 'REC-EVIDENCE-001');
  console.log('  (record sealed by the court)');
  const esc = await scenario('ESCALATE', 'insp.sharma', 'REC-EVIDENCE-001',
    'I need to view the sealed evidence record for case CASE-2026-001 for my investigation.');

  console.log('\n=== B. HUMAN REVIEW ===');
  if (esc.decisionId) {
    const pend = await fabric.evaluate('court', 'judge.rana', 'AccessContract', 'QueryPendingEscalations');
    const visible = pend.some((p) => p.decisionId === esc.decisionId);
    const res = await fabric.submit('court', 'judge.rana', 'AccessContract', 'ApproveEscalation',
      'REC-EVIDENCE-001', esc.decisionId, 'court authorises opening of the sealed record');
    out.review = { reviewerVisible: visible, finalStatus: res.status,
      byMsp: res.resolution?.byMsp, byRole: res.resolution?.byRole,
      explanationRetained: Boolean(res.explanation?.reasonCode) };
    console.log(`  visible to reviewer: ${visible}; resolved -> ${res.status} by ${res.resolution?.byRole} of ${res.resolution?.byMsp}`);
    persist();
  }
  await fabric.submit('court', 'judge.rana', 'RecordContract', 'UnsealRecord', 'REC-EVIDENCE-001');
  console.log('  (record unsealed)');

  console.log(`\n=== C. LATENCY, N=${N} (ALLOW path) ===`);
  for (let i = 0; i < N; i += 1) {
    try {
      const r = await runOne('insp.sharma', 'REC-FIR-001',
        `Investigation query ${i}: I need to view the first information report for case CASE-2026-001.`);
      out.latency.push({ i, requestMs: r.requestMs, waitMs: r.waitMs, totalMs: r.totalMs,
        inferenceMs: r.decision?.inference?.latencyMs, decision: r.decision?.decision,
        reasonCode: r.decision?.explanation?.reasonCode, answered: Boolean(r.decision) });
      console.log(`  ${i + 1}/${N} req=${r.requestMs}ms wait=${r.waitMs}ms total=${r.totalMs}ms inf=${r.decision?.inference?.latencyMs || '-'}ms`);
    } catch (e) {
      out.latency.push({ i, error: e.message });
      console.log(`  ${i + 1}/${N} ERROR ${e.message.slice(0, 80)}`);
    }
    persist();
  }
  console.log('\nraw -> experiments/seal-eval/results2.json');
  process.exit(0);
})().catch((e) => { console.error('harness failed:', e.message); persist(); process.exit(1); });
