#!/usr/bin/env node
'use strict';
/**
 * SEAL adversarial checks, independent of the model server.
 * A well-formed decision artifact is constructed deterministically from the
 * policy engine, so the ledger-side validation classes can be exercised
 * without invoking the language model.
 */
const fs = require('fs'), crypto = require('crypto');
const fabric = require('../../backend/src/fabric/gateway');
const { signAttestation } = require('../../backend/src/llm/policyAttestation');
const { evaluate } = require('../../chaincode/crimerecords/lib/policy/policyEngine');
const { materializeDecision } = require('../../backend/src/llm/policyPrompt');
const policyDecision = require('../../backend/src/llm/policyDecision');
const BASE = process.env.API_BASE || 'http://localhost:3001/api';

const results = [];
function ccMsg(e) {
  const d = e && e.details;
  if (Array.isArray(d) && d.length) return d.map((x) => x.message || JSON.stringify(x)).join(' | ');
  return e && e.message ? e.message : String(e);
}
const rec = (id, attempt, refused, detail) => {
  results.push({ id, attempt, refused, detail: String(detail || '').slice(0, 200) });
  console.log(`  ${refused ? 'REFUSED ' : 'ALLOWED '} ${id}  ${attempt}`);
  if (detail) console.log(`            ${String(detail).slice(0, 140)}`);
};
async function api(m, p, { token, body } = {}) {
  const r = await fetch(`${BASE}${p}`, { method: m,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (u) => (await api('POST', '/auth/login', { body: { username: u } })).json.data.token;

/** Build a valid, policy-consistent decision artifact for a request context.
 *  Mirrors the current protocol: the model supplies only an advisory compact
 *  classification, and the controlled module derives decision + explanation. */
function buildArtifact(ctx) {
  const { subject, record } = ctx.snapshot;
  const trusted = { subject, record, requestContext: ctx.snapshot.requestContext || {} };
  const cd = require('../../chaincode/crimerecords/lib/policy/controlledDecision');
  const pp = require('../../backend/src/llm/policyPrompt');
  const p = evaluate(subject, record, 'view', { purpose: 'investigation' });
  // Advisory classification that AGREES with the policy, so the control must pass.
  const advisory = { action: 'view', purpose: 'investigation', decision: p.decision,
    reasonCode: p.reasonCode, policyVersion: p.policyVersion, modelVersion: pp.MODEL_VERSION };
  const { effective } = cd.deriveEffectiveClassification(advisory, trusted);
  const decision = cd.materializeDecision(effective, trusted);
  const inference = {
    modelVersion: advisory.modelVersion, servedModel: 'deterministic-harness',
    adapterHash: require('../../backend/src/config').LLM_POLICY_ADAPTER_HASH,
    promptHash: crypto.createHash('sha256').update('harness').digest('hex'),
    outputHash: policyDecision.hashObject(decision), latencyMs: 1,
    modelClassification: advisory,
  };
  return { decision, inference, advisory };
}

async function freshRequest(user, org, recordId, note) {
  return fabric.submitWithTransient(org, user, 'AccessContract', 'CreateAccessRequest',
    [recordId, '{}'], { query: Buffer.from(note, 'utf8') }, fabric.ACCESS_QUERY_ENDORSERS);
}

(async () => {
  console.log('\n=== ADVERSARIAL CHECKS (model-independent) ===\n');

  // --- N1: reuse of an authorization by a different identity -------------
  const shar = await login('insp.sharma');
  const mine = await fabric.evaluate('police', 'insp.sharma', 'AccessContract',
    'QueryDecisionsByRecord', 'REC-FIR-001');
  const myHash = mine.length ? mine[0].subject?.identityHash : null;
  const granted = mine.find((d) => d.status === 'granted' && d.action === 'view');
  if (granted) {
    const ok = await api('GET', `/records/REC-FIR-001/metadata/${granted.decisionId}`, { token: shar });
    rec('N1a', 'the originating requester opens the record under their own ALLOW (control)',
      ok.status === 200, `HTTP ${ok.status}`);
    const other = await login('io.krishnan');
    const steal = await api('GET', `/records/REC-FIR-001/metadata/${granted.decisionId}`, { token: other });
    rec('N1b', 'a second officer opens the record under that same ALLOW',
      steal.status !== 200, `HTTP ${steal.status}: ${steal.json?.error}`);
  } else rec('N1', 'no granted decision available to test reuse', false, '');

  // --- N2/N3: non-AI identity reads context / submits a decision ----------
  const r2 = await freshRequest('insp.sharma', 'police', 'REC-FIR-001', 'adversarial probe N2');
  try {
    await fabric.evaluate('police', 'insp.sharma', 'AccessContract',
      'GetAccessRequestForDecision', r2.requestId);
    rec('N2', 'a police identity reads the AI-only decision context', false, 'succeeded');
  } catch (e) { rec('N2', 'a police identity reads the AI-only decision context', true, ccMsg(e)); }
  try {
    await fabric.submit('police', 'insp.sharma', 'AccessContract', 'SubmitLLMDecision',
      r2.requestId, '{}', '{}', `${'A'.repeat(86)}==`);
    rec('N3', 'a police identity submits a model decision', false, 'succeeded');
  } catch (e) { rec('N3', 'a police identity submits a model decision', true, ccMsg(e)); }

  // --- N4-N7: attestation and replay, on a deterministic artifact ---------
  const ctx = await fabric.evaluate('ai', 'llm-decider', 'AccessContract',
    'GetAccessRequestForDecision', r2.requestId).catch(() => null);
  if (ctx && ctx.status === 'requested') {
    const { decision, inference } = buildArtifact(ctx);
    const good = signAttestation({ queryHash: ctx.queryHash, contextHash: ctx.contextHash, decision, inference });

    const flipped = (good[0] === 'A' ? 'B' : 'A') + good.slice(1);
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        r2.requestId, JSON.stringify(decision), JSON.stringify(inference), flipped);
      rec('N4', 'a decision carrying a corrupted attestation', false, 'succeeded');
    } catch (e) { rec('N4', 'a decision carrying a corrupted attestation', true, ccMsg(e)); }

    const foreign = crypto.generateKeyPairSync('ed25519');
    const foreignSig = signAttestation({ queryHash: ctx.queryHash, contextHash: ctx.contextHash, decision, inference },
      { privateKeyPem: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        r2.requestId, JSON.stringify(decision), JSON.stringify(inference), foreignSig);
      rec('N5', 'a decision signed by a key that is not the registered one', false, 'succeeded');
    } catch (e) { rec('N5', 'a decision signed by a key that is not the registered one', true, ccMsg(e)); }

    // Genuine tampering: flip to a reason the policy did NOT produce.
    const flipTo = decision.reasonCode === 'POLICY_SATISFIED'
      ? { decision: 'deny', reasonCode: 'NOT_ASSIGNED' }
      : { decision: 'allow', reasonCode: 'POLICY_SATISFIED' };
    const tampered = { ...decision, ...flipTo };
    if (tampered.reasonCode === decision.reasonCode) {
      rec('N6', 'tamper case degenerate — skipped', false, 'reason unchanged');
    } else {
      try {
        await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
          r2.requestId, JSON.stringify(tampered), JSON.stringify(inference), good);
        rec('N6', 'a decision payload altered after the attestation was produced', false, 'succeeded');
      } catch (e) { rec('N6', 'a decision payload altered after the attestation was produced', true, ccMsg(e)); }
    }

    // N7 gets its own request so the control is not consumed by an earlier check.
    const r7 = await freshRequest('insp.sharma', 'police', 'REC-FIR-001', 'adversarial probe N7');
    const c7 = await fabric.evaluate('ai', 'llm-decider', 'AccessContract',
      'GetAccessRequestForDecision', r7.requestId).catch(() => null);
    if (c7 && c7.status === 'requested') {
      const a7 = buildArtifact(c7);
      const s7 = signAttestation({ queryHash: c7.queryHash, contextHash: c7.contextHash,
        decision: a7.decision, inference: a7.inference });
      try {
        await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
          r7.requestId, JSON.stringify(a7.decision), JSON.stringify(a7.inference), s7);
        rec('N7a', 'a correctly attested, policy-consistent decision (control)', true,
          `accepted: ${a7.decision.decision} / ${a7.decision.reasonCode}`);
        try {
          await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
            r7.requestId, JSON.stringify(a7.decision), JSON.stringify(a7.inference), s7);
          rec('N7b', 'a second decision for the same request (replay)', false, 'succeeded');
        } catch (e) { rec('N7b', 'a second decision for the same request (replay)', true, ccMsg(e)); }
      } catch (e) { rec('N7a', 'a correctly attested, policy-consistent decision (control)', false, ccMsg(e)); }
    } else rec('N7', 'no fresh context for the control', false, '');
  } else {
    rec('N4-N7', 'AI context unavailable', false, ctx ? `status=${ctx.status}` : 'none');
  }

  // --- N8: stale authorization context (TOCTOU) --------------------------
  const r8 = await freshRequest('insp.sharma', 'police', 'REC-EVIDENCE-001', 'adversarial probe N8');
  const c8 = await fabric.evaluate('ai', 'llm-decider', 'AccessContract',
    'GetAccessRequestForDecision', r8.requestId).catch(() => null);
  if (c8 && c8.status === 'requested') {
    const a8 = buildArtifact(c8);
    const sig8 = signAttestation({ queryHash: c8.queryHash, contextHash: c8.contextHash,
      decision: a8.decision, inference: a8.inference });
    await fabric.submit('court', 'judge.rana', 'RecordContract', 'SealRecord', 'REC-EVIDENCE-001');
    try {
      await fabric.submit('ai', 'llm-decider', 'AccessContract', 'SubmitLLMDecision',
        r8.requestId, JSON.stringify(a8.decision), JSON.stringify(a8.inference), sig8);
      rec('N8', 'a decision computed before the record was sealed, submitted after', false, 'succeeded');
    } catch (e) { rec('N8', 'a decision computed before the record was sealed, submitted after', true, ccMsg(e)); }
    await fabric.submit('court', 'judge.rana', 'RecordContract', 'UnsealRecord', 'REC-EVIDENCE-001');
  } else rec('N8', 'context unavailable for the staleness check', false, '');

  fs.writeFileSync('experiments/seal-eval/negative-results.json',
    JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  const good = results.filter((r) => r.refused).length;
  console.log(`\n${good}/${results.length} checks behaved as intended\n`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
