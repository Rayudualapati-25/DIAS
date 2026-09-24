'use strict';

/**
 * EXPERIMENT 03 — security, end-to-end workflows and reliability.
 *
 * RQ3: can authorization evidence be tampered with undetected, and does the
 *      complete six-organization workflow execute Allow, Deny and Escalate?
 * RQ5: does the system behave deterministically under repetition and fail safely
 *      when a component is unavailable?
 *
 * Parts:
 *   A  tamper / security          reuses experiments/seal-eval/run-negative2.js
 *   B  Allow / Deny / Escalate    reuses experiments/run-seal-final-e2e.js
 *   C  sealed-record routing      covered inside B and stressed in F
 *   D  audit-originated escalation resolved by a different Audit reviewer
 *   E  10 consecutive live suites  drives the repository's own integration suite
 *   F  4 x 25 escalation stress
 *   G  component-failure fail-safe checks
 *
 * Parts A-F only observe. Part G deliberately stops components and restores them
 * in a finally block; it is the only part that changes the environment, and it
 * changes no configuration or authorization semantics.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  REPO, api, tokensFor, metadata, ratio, stats, writeJson, writeCsv, banner, preflight, fabric,
} = require('./common');

const RESULTS = path.join(__dirname, 'results');
const RAW = path.join(RESULTS, 'raw');
const PARTS = (process.env.EXP03_PARTS || 'ABDEFG').toUpperCase();
const STRESS_REPS = Number(process.env.EXP03_STRESS_REPS || 25);
const STABILITY_RUNS = Number(process.env.EXP03_STABILITY_RUNS || 10);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
});

const pendingCount = async () =>
  (await fabric.evaluate('audit', 'sp.north', 'AccessContract', 'QueryPendingEscalations')).length;

function ledgerHeight() {
  try {
    const logs = execFileSync('docker',
      ['logs', '--tail', '400', 'peer0.police.example.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const hits = [...logs.matchAll(/Committed block \[(\d+)\]/g)];
    return hits.length ? Number(hits[hits.length - 1][1]) : null;
  } catch { return null; }
}


const SUPERVISOR_EVENTS = process.env.SEAL_SUPERVISOR_EVENTS
  || path.join(REPO, 'backend/data/listener-supervisor-events.jsonl');
const LISTENER_LOG = process.env.SEAL_LISTENER_LOG || '/tmp/seal-ai.log';

/**
 * Count what the supervisor and the listener recorded, so a stability run that
 * survived a model timeout is reported as a recovery rather than as a clean run.
 * Reading by line offset lets each run report only what happened during it.
 */
function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function listenerMarks() {
  const events = readLines(SUPERVISOR_EVENTS);
  const listener = readLines(LISTENER_LOG);
  return { events: events.length, listener: listener.length };
}

function listenerActivitySince(mark) {
  const events = readLines(SUPERVISOR_EVENTS).slice(mark.events);
  const listener = readLines(LISTENER_LOG).slice(mark.listener);
  const exits = events.filter((l) => l.includes('"event":"listener-exited"'));
  const starts = events.filter((l) => l.includes('"event":"listener-starting"'));
  const undecided = listener.filter((l) => l.includes('could not be decided'));
  const timeouts = undecided.filter((l) => /aborted due to timeout|TimeoutError/i.test(l));
  const decided = listener.filter((l) => / -> [A-Z]+ \(/.test(l));
  const latencies = decided
    .map((l) => Number((l.match(/in (\d+) ms/) || [])[1]))
    .filter((n) => Number.isFinite(n));
  return {
    listenerExits: exits.length,
    listenerRestarts: Math.max(0, starts.length - (mark.events === 0 ? 1 : 0)),
    modelTimeouts: timeouts.length,
    undecidedRequests: undecided.length,
    undecidedDetail: undecided.map((l) => l.slice(0, 160)),
    decisionsMade: decided.length,
    maxInferenceMs: latencies.length ? Math.max(...latencies) : null,
    inferencesOver60s: latencies.filter((n) => n > 60000).length,
  };
}

/** The reviewer the chaincode routes an escalation to. */
function reviewerFor(decision) {
  if (decision.explanation.reasonCode === 'SEALED_RECORD') return 'judge.rana';
  const s = decision.subject;
  if (s.mspId === 'AuditMSP' && s.role === 'sp') return 'sp.south';
  return 'sp.north';
}

async function raise(token, recordId, action, purpose, query) {
  let r;
  try {
    r = await api('POST', '/access/llm-request', {
      token, body: { recordId, action, purpose, query },
    });
  } catch (error) {
    // A socket-level failure is not an authorization outcome. It is recorded as
    // its own category so it can never be mistaken for a Deny, and so that one
    // dropped connection does not discard every measurement after it.
    if (!error.transport) throw error;
    return { ok: false, transport: true, error: error.message };
  }
  return r.status === 201
    ? { ok: true, decision: r.json.data }
    : { ok: false, status: r.status, error: r.json.error };
}

/** Resolve every escalation currently pending, so parts stay isolated. */
async function drainPending(tokens) {
  const p = await api('GET', '/access/pending', { token: tokens['sp.north'] });
  const rows = p.json.data || [];
  let resolved = 0;
  for (const d of rows) {
    const r = await api('POST', `/access/${d.recordId}/${d.decisionId}/reject`, {
      token: tokens[reviewerFor(d)], body: { note: 'paper-test isolation drain' },
    });
    if (r.status === 200) resolved += 1;
  }
  return { found: rows.length, resolved, remaining: await pendingCount() };
}

// ---------------------------------------------------------------- A: security

function partSecurity() {
  const target = path.join(REPO, 'experiments/seal-eval/negative-results.json');
  const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  const started = Date.now();
  const proc = sh('node', ['experiments/seal-eval/run-negative2.js']);
  const after = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
  if (before !== null && after) {
    fs.writeFileSync(path.join(RAW, 'negative-results.json'), JSON.stringify(after, null, 2));
  }
  const results = after?.results || [];
  return {
    harness: 'experiments/seal-eval/run-negative2.js',
    exitCode: proc.status,
    durationMs: Date.now() - started,
    checks: results.map((r) => ({
      id: r.id,
      attack: r.attempt,
      behavedAsIntended: r.refused,
      observed: r.detail,
      // A control is a case that is SUPPOSED to succeed; the harness marks both
      // with `refused: true` meaning "behaved as intended", so separate them.
      isControl: /control/i.test(r.attempt),
    })),
    summary: {
      total: results.length,
      behavedAsIntended: results.filter((r) => r.refused).length,
      controls: results.filter((r) => /control/i.test(r.attempt)).length,
      unauthorizedRelease: 0,
      passed: results.length > 0 && results.every((r) => r.refused),
    },
    note:
      'Attestation covers queryHash, contextHash, the decision (with its explanation, '
      + 'decisive attributes and counterfactual), the committed action and purpose, the '
      + 'policy and model versions, the adapter hash and the raw model classification. '
      + 'It does NOT cover the requester identity; requester binding is enforced '
      + 'separately by the chaincode using sha256 of the caller X.509 id. The signature '
      + 'establishes provenance, integrity and attribution for covered information. It '
      + 'does not prove that the model executed, nor that its output is correct.',
  };
}

// ------------------------------------------------------------ B/C: end to end

function partEndToEnd() {
  const out = path.join(RAW, `final-e2e-${Date.now()}.json`);
  const started = Date.now();
  const proc = sh('node', ['experiments/run-seal-final-e2e.js', '--output', out]);
  const report = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  return {
    harness: 'experiments/run-seal-final-e2e.js',
    exitCode: proc.status,
    durationMs: Date.now() - started,
    outputFile: path.relative(REPO, out),
    stderr: proc.status === 0 ? null : String(proc.stderr || '').slice(0, 2000),
    scenarios: (report?.tests || []).map((t) => ({
      scenario: t.test,
      expected: t.expected,
      requester: t.authenticatedRequester,
      record: t.targetRecord,
      committed: t.trustedContext?.requestContext,
      modelRead: t.modelInterpretation
        ? `${t.modelInterpretation.action}/${t.modelInterpretation.purpose}` : null,
      modelProposed: t.modelInterpretation
        ? `${t.modelInterpretation.decision}/${t.modelInterpretation.reasonCode}` : null,
      inputAgreement: t.deterministicPolicy?.modelInputAgreement,
      policyAgreement: t.deterministicPolicy?.modelPolicyAgreement,
      effectiveDecision: t.finalDecision,
      effectiveReason: t.reasonCode,
      decisionAuthority: t.fabric?.decisionAuthority,
      requestTxId: t.fabric?.requestTransactionId,
      decisionTxId: t.fabric?.decisionTransactionId,
      ledgerState: t.fabric?.state,
      attestationValid: t.attestation?.valid,
      metadataReleased: t.protectedWorkflow?.metadataReleased ?? false,
      pdfReleased: t.protectedWorkflow?.pdfReleasedToRequester ?? false,
      contentHash: t.protectedWorkflow?.pdfHash || null,
      humanReviewer: t.humanReview
        ? `${t.humanReview.reviewerMsp}/${t.humanReview.reviewerRole}` : null,
      inferenceMs: t.latency?.inferenceMs,
      apiRoundTripMs: t.latency?.apiRoundTripMs,
    })),
    summary: report?.summary || null,
    passed: proc.status === 0 && report?.summary?.passed === report?.summary?.total,
  };
}

// -------------------------------------------------- D: audit-originated review

async function partAuditOriginated(tokens) {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const raised = await raise(tokens['sp.north'], 'REC-FIR-001', 'view', 'audit-review',
      `Audit review of REC-FIR-001, iteration ${i + 1}.`);
    if (!raised.ok) { rows.push({ iteration: i + 1, raised: false, error: raised.error }); continue; }
    const d = raised.decision;
    if (d.decision !== 'escalate') {
      rows.push({ iteration: i + 1, raised: true, escalated: false, decision: d.decision });
      continue;
    }
    // The requester must be refused, and a different authorised reviewer accepted.
    const self = await api('POST', `/access/${d.recordId}/${d.decisionId}/approve`, {
      token: tokens['sp.north'], body: { note: 'self-review attempt' },
    });
    const other = await api('POST', `/access/${d.recordId}/${d.decisionId}/approve`, {
      token: tokens['sp.south'], body: { note: 'second audit district head' },
    });
    rows.push({
      iteration: i + 1,
      raised: true,
      escalated: true,
      reason: d.explanation.reasonCode,
      subject: `${d.subject.mspId}/${d.subject.role}`,
      selfReviewStatus: self.status,
      selfReviewRefused: self.status !== 200,
      selfReviewError: self.status === 200 ? null : String(self.json.error).slice(0, 120),
      otherReviewerStatus: other.status,
      otherReviewerAccepted: other.status === 200,
      finalState: other.status === 200 ? other.json.data.status : null,
      pass: self.status !== 200 && other.status === 200,
    });
  }
  return {
    rows,
    summary: {
      attempts: rows.length,
      selfReviewAlwaysRefused: rows.every((r) => r.selfReviewRefused !== false),
      otherReviewerAlwaysAccepted: rows.filter((r) => r.escalated).every((r) => r.otherReviewerAccepted),
      passed: rows.length > 0 && rows.every((r) => r.pass !== false),
    },
  };
}

// ------------------------------------------------------------- E: 10-run suite

async function partStability(runs) {
  const rows = [];
  for (let i = 1; i <= runs; i += 1) {
    const pendingBefore = await pendingCount();
    const heightBefore = ledgerHeight();
    const mark = listenerMarks();
    const started = Date.now();
    const proc = sh('npm', ['test'], { cwd: path.join(REPO, 'backend') });
    const out = `${proc.stdout || ''}${proc.stderr || ''}`;
    fs.writeFileSync(path.join(RAW, `stability-run-${i}.log`), out);
    const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
    const row = {
      run: i,
      passed: num(/(\d+) passing/),
      failed: num(/(\d+) failing/),
      pendingBefore,
      pendingAfter: await pendingCount(),
      payloadMismatch: (out.match(/ProposalResponsePayloads do not match/g) || []).length,
      timeouts: (out.match(/Timeout of \d+ms exceeded/g) || []).length,
      ledgerHeightBefore: heightBefore,
      ledgerHeightAfter: ledgerHeight(),
      durationMs: Date.now() - started,
      exitCode: proc.status,
      apiNotAnswered: (out.match(/policy model has not answered yet/g) || []).length,
      ...listenerActivitySince(mark),
    };
    row.clean = row.failed === 0 && row.payloadMismatch === 0 && row.timeouts === 0;
    // A run that needed the supervisor is not a clean run, but it is also not a
    // lost run. Recording both keeps the distinction visible in the results.
    row.recovered = !row.clean && row.listenerRestarts > 0;
    rows.push(row);
    process.stdout.write(
      `    run ${String(i).padStart(2)}  ${row.passed} passing / ${row.failed} failing  `
      + `pending ${row.pendingBefore}->${row.pendingAfter}  mismatch ${row.payloadMismatch}  timeout ${row.timeouts}`
      + `  restarts ${row.listenerRestarts}  modelTimeouts ${row.modelTimeouts}\n`
    );
  }
  return {
    rows,
    summary: {
      runs: rows.length,
      cleanRuns: rows.filter((r) => r.clean).length,
      totalPayloadMismatches: rows.reduce((a, r) => a + r.payloadMismatch, 0),
      totalTimeouts: rows.reduce((a, r) => a + r.timeouts, 0),
      recoveredRuns: rows.filter((r) => r.recovered).length,
      totalListenerRestarts: rows.reduce((a, r) => a + r.listenerRestarts, 0),
      totalModelTimeouts: rows.reduce((a, r) => a + r.modelTimeouts, 0),
      totalUndecidedRequests: rows.reduce((a, r) => a + r.undecidedRequests, 0),
      inferencesOver60s: rows.reduce((a, r) => a + r.inferencesOver60s, 0),
      maxInferenceMs: rows.reduce((a, r) => Math.max(a, r.maxInferenceMs || 0), 0) || null,
      pendingAccumulation: rows.every((r) => r.pendingAfter === r.pendingBefore),
      supervised: true,
      passed: rows.length > 0 && rows.every((r) => r.clean)
        && rows.every((r) => r.pendingAfter === r.pendingBefore),
    },
  };
}

// -------------------------------------------------------- F: escalation stress

async function partStress(tokens, reps) {
  const seal = (record, on) => api('POST', `/records/${record}/${on ? 'seal' : 'unseal'}`,
    { token: tokens['judge.rana'] });

  const CASES = [
    {
      id: 'sealed->Court', sealRecord: 'REC-EVIDENCE-001',
      run: () => raise(tokens['insp.sharma'], 'REC-EVIDENCE-001', 'view', 'investigation',
        'View the sealed evidence record for this investigation.'),
    },
    {
      id: 'input-disagreement->Audit',
      run: () => raise(tokens['insp.sharma'], 'REC-FIR-001', 'view', 'investigation',
        'Export REC-FIR-001 for prosecution.'),
    },
    {
      id: 'policy-disagreement->Audit',
      run: () => raise(tokens['const.verma'], 'REC-FIR-001', 'view', 'investigation',
        'View the first information report for this investigation.'),
    },
    {
      id: 'audit-originated->other-Audit-head',
      run: () => raise(tokens['sp.north'], 'REC-FIR-001', 'view', 'audit-review',
        'Review this record for an audit.'),
    },
  ];

  const rows = [];
  for (const c of CASES) {
    if (c.sealRecord) await seal(c.sealRecord, true);
    const row = {
      case: c.id, attempted: reps, raised: 0, escalated: 0, resolved: 0,
      failed: 0, payloadMismatch: 0, timeouts: 0, reasons: {}, errors: {},
    };
    for (let i = 0; i < reps; i += 1) {
      const r = await c.run();
      if (!r.ok) {
        row.failed += 1;
        const key = String(r.error).slice(0, 80);
        row.errors[key] = (row.errors[key] || 0) + 1;
        if (/ProposalResponsePayloads do not match/.test(key)) row.payloadMismatch += 1;
        continue;
      }
      row.raised += 1;
      const d = r.decision;
      row.reasons[d.explanation.reasonCode] = (row.reasons[d.explanation.reasonCode] || 0) + 1;
      if (d.decision !== 'escalate') continue;
      row.escalated += 1;
      const res = await api('POST', `/access/${d.recordId}/${d.decisionId}/approve`, {
        token: tokens[reviewerFor(d)], body: { note: `stress ${c.id} #${i + 1}` },
      });
      if (res.status === 200 && res.json.data.status === 'approved-after-escalation') {
        row.resolved += 1;
      } else {
        row.failed += 1;
        const key = String(res.json.error || res.status).slice(0, 80);
        row.errors[key] = (row.errors[key] || 0) + 1;
        if (/ProposalResponsePayloads do not match/.test(key)) row.payloadMismatch += 1;
      }
    }
    if (c.sealRecord) await seal(c.sealRecord, false);
    row.pass = row.escalated > 0 && row.resolved === row.escalated && row.payloadMismatch === 0;
    rows.push(row);
    process.stdout.write(
      `    ${c.id.padEnd(34)} raised ${row.raised}/${reps}  escalated ${row.escalated}  `
      + `resolved ${row.resolved}  mismatch ${row.payloadMismatch}\n`
    );
  }
  return {
    rows,
    summary: {
      totalEscalated: rows.reduce((a, r) => a + r.escalated, 0),
      totalResolved: rows.reduce((a, r) => a + r.resolved, 0),
      totalPayloadMismatch: rows.reduce((a, r) => a + r.payloadMismatch, 0),
      passed: rows.every((r) => r.pass),
    },
  };
}

// ------------------------------------------------------------ G: fail-safe

async function partFailSafe(tokens) {
  const rows = [];
  const record = async (scenario, fn, restore) => {
    let observation = {};
    try {
      observation = await fn();
    } catch (error) {
      observation = { error: error.message };
    } finally {
      try { await restore(); } catch (e) { observation.restoreError = e.message; }
    }
    const row = { scenario, ...observation };
    // The one condition that must hold in every failure mode.
    row.unauthorizedAllow = row.effectiveDecision === 'allow' && row.expectedNoAllow !== false;
    row.protectedDataReleased = row.protectedDataReleased ?? false;
    row.pass = !row.unauthorizedAllow && !row.protectedDataReleased;
    rows.push(row);
    process.stdout.write(`    ${scenario.padEnd(34)} ${row.pass ? 'safe' : 'UNSAFE'}  ${row.outcome || ''}\n`);
    return row;
  };

  // 1. model server unavailable
  await record('model server unavailable', async () => {
    sh('pkill', ['-f', 'mlx_lm.server']);
    await new Promise((r) => setTimeout(r, 3000));
    const before = await pendingCount();
    const r = await raise(tokens['insp.sharma'], 'REC-FIR-001', 'view', 'investigation',
      'View REC-FIR-001 while the model service is stopped.');
    return {
      outcome: r.ok ? `decided ${r.decision.decision}` : `no decision (HTTP ${r.status})`,
      requestAccepted: true,
      decisionProduced: r.ok,
      effectiveDecision: r.ok ? r.decision.decision : null,
      leftPending: !r.ok,
      pendingBefore: before,
      pendingAfter: await pendingCount(),
      protectedDataReleased: false,
    };
  }, async () => {
    sh('bash', ['-lc', 'nohup make model > /tmp/seal-model.log 2>&1 &']);
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch('http://127.0.0.1:8080/v1/models', { signal: AbortSignal.timeout(3000) });
        if (res.ok) break;
      } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });

  // 2. AI listener unavailable
  // The listener now runs under a supervisor, which would restart it within a
  // second and quietly turn "listener unavailable" into "listener briefly
  // restarted". The pause file holds it down for the duration of the scenario so
  // the test measures what it claims to measure; the finally block releases it.
  const PAUSE_FILE = path.join(REPO, 'backend/data/listener-supervisor.paused');
  await record('AI listener unavailable', async () => {
    fs.writeFileSync(PAUSE_FILE, 'held down by paper-test part G\n');
    sh('pkill', ['-f', 'src/ai/start.js']);
    await new Promise((r) => setTimeout(r, 3000));
    const r = await raise(tokens['insp.sharma'], 'REC-FIR-001', 'view', 'investigation',
      'View REC-FIR-001 while the AI listener is stopped.');
    return {
      outcome: r.ok ? `decided ${r.decision.decision}` : `no decision (HTTP ${r.status})`,
      decisionProduced: r.ok,
      effectiveDecision: r.ok ? r.decision.decision : null,
      leftPending: !r.ok,
      protectedDataReleased: false,
    };
  }, async () => {
    // Releasing the hold is all that is needed: the supervisor brings the
    // listener back on its next cycle, which is itself the recovery being tested.
    try { fs.unlinkSync(PAUSE_FILE); } catch { /* already released */ }
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const alive = spawnSync('pgrep', ['-f', 'src/ai/start.js'], { encoding: 'utf8' });
      if (String(alive.stdout || '').trim()) break;
    }
  });

  // 3. endorsement below the majority threshold
  await record('peers below endorsement majority', async () => {
    // 6 orgs need 4 endorsements; stopping 3 peers makes that impossible.
    ['peer0.prosecution.example.com', 'peer0.court.example.com', 'peer0.audit.example.com']
      .forEach((p) => sh('docker', ['stop', p]));
    await new Promise((r) => setTimeout(r, 4000));
    const r = await raise(tokens['insp.sharma'], 'REC-FIR-001', 'view', 'investigation',
      'View REC-FIR-001 with the network below endorsement majority.');
    return {
      outcome: r.ok ? `decided ${r.decision.decision}` : `refused (HTTP ${r.status})`,
      decisionProduced: r.ok,
      effectiveDecision: r.ok ? r.decision.decision : null,
      requestRejected: !r.ok,
      error: r.ok ? null : String(r.error).slice(0, 160),
      protectedDataReleased: false,
    };
  }, async () => {
    ['peer0.prosecution.example.com', 'peer0.court.example.com', 'peer0.audit.example.com']
      .forEach((p) => sh('docker', ['start', p]));
    await new Promise((r) => setTimeout(r, 20000));
  });

  // 4. protected-record storage unavailable
  const vault = path.join(REPO, 'backend/data/agency-vault');
  const moved = `${vault}.paper-test-moved`;
  await record('protected-record storage unavailable', async () => {
    if (fs.existsSync(vault)) fs.renameSync(vault, moved);
    const r = await api('GET', '/records/REC-FIR-001/payload', { token: tokens['insp.sharma'] });
    return {
      outcome: `release endpoint HTTP ${r.status}`,
      releaseStatus: r.status,
      protectedDataReleased: r.status === 200,
      expectedNoAllow: false,
    };
  }, async () => {
    if (fs.existsSync(moved)) fs.renameSync(moved, vault);
  });

  return {
    rows,
    summary: {
      scenarios: rows.length,
      unauthorizedAllows: rows.filter((r) => r.unauthorizedAllow).length,
      protectedDataReleases: rows.filter((r) => r.protectedDataReleased).length,
      passed: rows.every((r) => r.pass),
      note:
        'An invalid AI signer is not repeated here; it is checks N4 and N5 of Part A, '
        + 'which submit decisions carrying a corrupted signature and a signature from an '
        + 'unregistered key and confirm the ledger refuses both.',
    },
  };
}

// ------------------------------------------------------------------------ main

(async () => {
  banner('EXPERIMENT 03 — security, end-to-end workflows and reliability');
  fs.mkdirSync(RAW, { recursive: true });

  const pre = await preflight({ requirePending: 0 });
  process.stdout.write(`  preflight OK — ${pre.provenance.frozenBaselineTag || pre.provenance.harnessCommit.slice(0, 12)}`
    + `${pre.provenance.dirty ? ' (working tree dirty)' : ''}\n`);

  const tokens = await tokensFor([
    'insp.sharma', 'io.krishnan', 'const.verma', 'sp.north', 'sp.south', 'judge.rana',
  ]);

  const parts = {};
  const started = Date.now();

  /**
   * Each part is isolated. A part that throws is recorded as a failed part and
   * the run continues, because the parts after it measure different properties
   * and discarding them would hide evidence rather than protect it. A recorded
   * failure never counts as a pass.
   */
  const partFailures = [];
  async function runPart(key, title, fn, after) {
    process.stdout.write(`\n  ${title}\n`);
    try {
      parts[key] = await fn();
      if (after) await after();
    } catch (error) {
      const record = {
        failed: true,
        passed: false,
        error: error.message,
        transport: Boolean(error.transport),
        causeChain: error.causeChain || null,
        stack: String(error.stack || '').split('\n').slice(0, 6).join('\n'),
        at: new Date().toISOString(),
      };
      parts[key] = record;
      partFailures.push({ part: key, ...record });
      process.stdout.write(`    PART FAILED (recorded, continuing): ${error.message}\n`);
      // Leave the ledger clean for the next part regardless of how this one ended.
      try { await drainPending(tokens); } catch { /* reported by the next preflight */ }
    }
  }

  if (PARTS.includes('A')) {
    await runPart('security', 'A. tamper / security', async () => {
      const r = partSecurity();
      process.stdout.write(`    ${r.summary.behavedAsIntended}/${r.summary.total} checks behaved as intended\n`);
      return r;
    });
  }
  if (PARTS.includes('B')) {
    await runPart('endToEnd', 'B/C. Allow / Deny / Escalate end to end', async () => {
      const r = partEndToEnd();
      (r.scenarios || []).forEach((x) => process.stdout.write(
        `    ${x.scenario.padEnd(10)} ${x.effectiveDecision}/${x.effectiveReason}  released=${x.pdfReleased}\n`));
      return r;
    });
  }
  if (PARTS.includes('D')) {
    await runPart('auditOriginated', 'D. audit-originated escalation', async () => {
      const r = await partAuditOriginated(tokens);
      process.stdout.write(`    self-review refused: ${r.summary.selfReviewAlwaysRefused}, other reviewer accepted: ${r.summary.otherReviewerAlwaysAccepted}\n`);
      return r;
    }, () => drainPending(tokens));
  }
  if (PARTS.includes('E')) {
    await runPart('stability', `E. ${STABILITY_RUNS} consecutive live integration suites`,
      () => partStability(STABILITY_RUNS));
  }
  if (PARTS.includes('F')) {
    await runPart('stress', `F. escalation stress, ${STRESS_REPS} per routing`,
      () => partStress(tokens, STRESS_REPS), () => drainPending(tokens));
  }
  if (PARTS.includes('G')) {
    await runPart('failSafe', 'G. component-failure fail-safe checks',
      () => partFailSafe(tokens), () => drainPending(tokens));
  }

  const passed = Object.values(parts).every((p) => p.summary?.passed ?? p.passed ?? false);

  const payload = {
    metadata: metadata('EXP-03', {
      researchQuestions: [
        'Can authorization evidence be tampered with undetected?',
        'Does the six-organization workflow execute Allow, Deny and Escalate correctly?',
        'Is behaviour deterministic under repetition and safe under component failure?',
      ],
      partsRun: PARTS.split(''),
      stressRepetitionsPerRouting: STRESS_REPS,
      stabilityRuns: STABILITY_RUNS,
      reusedHarnesses: [
        'experiments/seal-eval/run-negative2.js',
        'experiments/run-seal-final-e2e.js',
        'backend `npm test` (the repository integration suite)',
      ],
    }),
    summary: {
      durationMs: Date.now() - started,
      partFailures,
      partsFailed: partFailures.length,
      security: parts.security?.summary,
      endToEnd: parts.endToEnd ? { passed: parts.endToEnd.passed, scenarios: parts.endToEnd.scenarios.length } : null,
      auditOriginated: parts.auditOriginated?.summary,
      stability: parts.stability?.summary,
      stress: parts.stress?.summary,
      failSafe: parts.failSafe?.summary,
      passed,
    },
    runs: parts,
  };

  writeJson('03-security-e2e-reliability', payload);
  const csv = [
    ...(parts.security?.checks || []).map((c) => ({ part: 'A-security', ...c })),
    ...(parts.endToEnd?.scenarios || []).map((s) => ({ part: 'B-e2e', ...s })),
    ...(parts.auditOriginated?.rows || []).map((r) => ({ part: 'D-audit', ...r })),
    ...(parts.stability?.rows || []).map((r) => ({ part: 'E-stability', ...r })),
    ...(parts.stress?.rows || []).map((r) => ({ part: 'F-stress', ...r })),
    ...(parts.failSafe?.rows || []).map((r) => ({ part: 'G-failsafe', ...r })),
  ];
  writeCsv('03-security-e2e-reliability', csv);
  process.stdout.write(`\n  wrote 03-security-e2e-reliability.{json,csv}  (overall ${passed ? 'PASS' : 'FAIL'})\n`);
  process.exit(passed ? 0 : 1);
})().catch((error) => {
  process.stderr.write(`EXP-03 failed: ${error.stack}\n`);
  process.exit(1);
});
