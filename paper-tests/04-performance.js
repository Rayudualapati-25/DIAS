'use strict';

/**
 * EXPERIMENT 04 — latency decomposition and concurrency.
 *
 * RQ4: what latency and scalability overhead does SEAL add on top of the model?
 *
 * WHAT IS MEASURED, AND WHAT IS NOT
 *
 * Three quantities are directly observable without changing the system:
 *
 *   T_model      the inference time recorded inside the signed inference
 *                descriptor, measured around the model HTTP call itself
 *   T_end_to_end the client-observed round trip of POST /access/llm-request
 *   T_remainder  T_end_to_end - T_model
 *
 * T_remainder is reported as ONE figure and is an UPPER BOUND on the SEAL
 * overhead. It contains, and cannot currently separate: the request-creation
 * transaction, the listener's event pickup, the ledger read of the request
 * context, the deterministic guard, explanation materialisation, Ed25519
 * signing, endorsement, ordering, commit, and the API's 250 ms decision poll.
 *
 * T_context, T_validator, T_explanation, T_signature, T_endorsement and
 * T_commit are NOT reported separately. Separating them requires timestamps
 * inside the AI decision service, which is frozen code; that instrumentation is
 * proposed but not applied here. Nothing in this file invents a stage timing.
 *
 * One further decomposition IS available without instrumentation: the model
 * server is called directly with the same prompt shape, which isolates raw
 * inference from everything SEAL adds around it.
 */

const path = require('path');
const {
  REPO, API, MODEL_URL, api, tokensFor, metadata, stats, ratio,
  writeJson, writeCsv, banner, preflight, fabric,
} = require('./common');

const REPS = Number(process.env.EXP04_REPS || 60);
const WARMUP = Number(process.env.EXP04_WARMUP || 5);
const LEVELS = (process.env.EXP04_LEVELS || '1,5,10,20').split(',').map(Number);

const groundedPrompt = require(path.join(REPO, 'backend/src/llm/groundedPolicyPrompt'));
const promptBuilder = require(path.join(REPO, 'backend/src/llm/policyPrompt'));


// ------------------------------------------------- measured decision stages

const fs = require('fs');
const STAGE_TIMINGS_FILE = process.env.SEAL_STAGE_TIMINGS_FILE
  || path.join(REPO, 'backend/data/decision-timings.jsonl');
const SUPERVISOR_EVENTS = process.env.SEAL_SUPERVISOR_EVENTS
  || path.join(REPO, 'backend/data/listener-supervisor-events.jsonl');

const lineCount = (file) => {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
};

/**
 * Stage timings are written by the decision service, one line per answered
 * request, and are read back by window rather than joined per request: the API
 * response does not carry the ledger request id. Each measurement phase records
 * the file offset before it starts and reads only the lines it produced, so a
 * phase never reports another phase's work.
 */
function stagesSince(offset) {
  let lines = [];
  try {
    lines = fs.readFileSync(STAGE_TIMINGS_FILE, 'utf8').split('\n').filter(Boolean).slice(offset);
  } catch { return null; }
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!rows.length) return null;
  const of = (key) => stats(rows.map((r) => r[key]).filter((n) => Number.isFinite(n)));
  return {
    answeredRequests: rows.length,
    contextReadMs: of('contextReadMs'),
    inferenceMs: of('inferenceMs'),
    validateExplainMs: of('validateExplainMs'),
    signatureMs: of('signatureMs'),
    fabricSubmitCommitMs: of('fabricSubmitCommitMs'),
    decisionServiceTotalMs: of('totalMs'),
    decisions: [...new Set(rows.map((r) => `${r.decision}/${r.reasonCode}`))],
    // The tail matters here: a single inference exceeding the model timeout was
    // observed during this evaluation, so the maximum and the count beyond the
    // timeout are reported rather than the mean alone.
    inferencesOver60s: rows.filter((r) => r.inferenceMs > 60000).length,
    maxInferenceMs: Math.max(...rows.map((r) => r.inferenceMs).filter(Number.isFinite)),
  };
}

const supervisorRestartsSince = (offset) => {
  try {
    return fs.readFileSync(SUPERVISOR_EVENTS, 'utf8').split('\n').filter(Boolean).slice(offset)
      .filter((l) => l.includes('"event":"listener-exited"')).length;
  } catch { return 0; }
};

/** The three authorization paths, each raised by a different identity. */
const PATHS = {
  allow: {
    user: 'insp.sharma', record: 'REC-FIR-001', action: 'view', purpose: 'investigation',
    query: 'View the first information report REC-FIR-001 for this investigation.',
  },
  deny: {
    user: 'insp.rathore', record: 'REC-FIR-001', action: 'view', purpose: 'investigation',
    query: 'View the first information report REC-FIR-001 for this investigation.',
  },
  escalate: {
    user: 'insp.sharma', record: 'REC-FIR-001', action: 'view', purpose: 'investigation',
    query: 'Export REC-FIR-001 for prosecution.',
  },
};

async function oneRequest(token, spec) {
  const t0 = Date.now();
  const r = await api('POST', '/access/llm-request', {
    token,
    body: { recordId: spec.record, action: spec.action, purpose: spec.purpose, query: spec.query },
  });
  const endToEndMs = Date.now() - t0;
  if (r.status !== 201) {
    return { ok: false, endToEndMs, status: r.status, error: String(r.json.error).slice(0, 120) };
  }
  const d = r.json.data;
  const inferenceMs = d.inference?.latencyMs ?? null;
  return {
    ok: true,
    endToEndMs,
    inferenceMs,
    remainderMs: inferenceMs === null ? null : endToEndMs - inferenceMs,
    decision: d.decision,
    reasonCode: d.explanation.reasonCode,
    decisionId: d.decisionId,
  };
}

/**
 * Raw model latency, bypassing SEAL entirely. Same decoding parameters and the
 * same prompt builders the runtime uses, so the comparison is like for like.
 */
async function modelOnly(reps) {
  const subject = {
    mspId: 'PoliceMSP', role: 'inspector', jurisdiction: 'district-north',
    clearance: 'high', credentialStatus: 'active', caseAssignments: 'CASE-1',
  };
  const record = {
    recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', recordType: 'fir',
    sensitivityLevel: 'medium', jurisdiction: 'district-north',
    sealed: false, juvenileFlag: false, victimProtectionFlag: false,
  };
  const messages = [
    { role: 'system', content: groundedPrompt.groundedSystemPrompt(subject, promptBuilder.MODEL_VERSION) },
    {
      role: 'user',
      content: promptBuilder.buildUserPrompt({
        query: PATHS.allow.query, subject, record, requestContext: {},
      }),
    },
  ];
  const samples = [];
  for (let i = 0; i < reps; i += 1) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${MODEL_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.LLM_POLICY_MODEL || 'default_model',
          messages, stream: false, temperature: 0, top_p: 1, max_tokens: 192,
        }),
        signal: AbortSignal.timeout(60000),
      });
      await res.json();
      samples.push(Date.now() - t0);
    } catch { /* a failed sample is dropped, and the count reflects it */ }
  }
  return samples;
}

/** Is the sample stationary? Compares the first and last fifths. */
function driftCheck(values) {
  if (values.length < 10) return null;
  const k = Math.max(3, Math.floor(values.length / 5));
  const head = values.slice(0, k);
  const tail = values.slice(-k);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(head);
  const last = mean(tail);
  return {
    firstFifthMeanMs: Math.round(first),
    lastFifthMeanMs: Math.round(last),
    ratio: ratio(last / first),
    stationary: Math.abs(last / first - 1) < 0.15,
  };
}

async function steadyState(tokens, name, spec, reps, warmup) {
  const token = tokens[spec.user];
  const warm = [];
  for (let i = 0; i < warmup; i += 1) warm.push(await oneRequest(token, spec));

  // Offsets are taken after the warm-up, so warm-up work is excluded from the
  // steady-state stage figures as well as from the latency figures.
  const stageOffset = lineCount(STAGE_TIMINGS_FILE);
  const supervisorOffset = lineCount(SUPERVISOR_EVENTS);
  const rows = [];
  for (let i = 0; i < reps; i += 1) rows.push(await oneRequest(token, spec));
  const ok = rows.filter((r) => r.ok);

  return {
    path: name,
    requested: reps,
    successes: ok.length,
    failures: rows.length - ok.length,
    warmupDiscarded: warmup,
    coldStartMs: warm.length ? warm[0].endToEndMs : null,
    decisions: [...new Set(ok.map((r) => `${r.decision}/${r.reasonCode}`))],
    endToEndMs: stats(ok.map((r) => r.endToEndMs)),
    inferenceMs: stats(ok.map((r) => r.inferenceMs)),
    remainderMs: stats(ok.map((r) => r.remainderMs)),
    drift: driftCheck(ok.map((r) => r.inferenceMs)),
    stages: stagesSince(stageOffset),
    listenerRestarts: supervisorRestartsSince(supervisorOffset),
    samples: rows,
  };
}

async function concurrency(tokens, level, spec) {
  const token = tokens[spec.user];
  const stageOffset = lineCount(STAGE_TIMINGS_FILE);
  const supervisorOffset = lineCount(SUPERVISOR_EVENTS);
  const t0 = Date.now();
  const settled = await Promise.all(
    Array.from({ length: level }, () => oneRequest(token, spec).catch((e) => ({ ok: false, error: e.message })))
  );
  const wallMs = Date.now() - t0;
  const ok = settled.filter((r) => r.ok);
  return {
    level,
    requests: level,
    successes: ok.length,
    failures: level - ok.length,
    wallClockMs: wallMs,
    throughputPerSec: ratio((ok.length / wallMs) * 1000),
    endToEndMs: stats(ok.map((r) => r.endToEndMs)),
    inferenceMs: stats(ok.map((r) => r.inferenceMs)),
    remainderMs: stats(ok.map((r) => r.remainderMs)),
    timeouts: settled.filter((r) => !r.ok && /202|not answered/.test(String(r.error || r.status))).length,
    errors: settled.filter((r) => !r.ok).map((r) => String(r.error || r.status).slice(0, 90)),
    stages: stagesSince(stageOffset),
    listenerRestarts: supervisorRestartsSince(supervisorOffset),
  };
}

(async () => {
  banner('EXPERIMENT 04 — latency decomposition and concurrency');
  const pre = await preflight({ requirePending: 0 });
  process.stdout.write(`  preflight OK — ${pre.provenance.frozenBaselineTag || pre.provenance.harnessCommit.slice(0, 12)}\n`);

  const tokens = await tokensFor([
    'insp.sharma', 'insp.rathore', 'sp.north', 'sp.south', 'judge.rana',
  ]);

  // ---- raw model, no SEAL ---------------------------------------------------
  process.stdout.write(`\n  model only (no ledger, no validator), ${WARMUP} warm-up + ${REPS} samples\n`);
  await modelOnly(WARMUP);
  const modelSamples = await modelOnly(REPS);
  const modelStats = stats(modelSamples);
  process.stdout.write(`    median ${modelStats.median} ms   p95 ${modelStats.p95} ms   n=${modelStats.n}\n`);

  // ---- steady state per path ------------------------------------------------
  const paths = {};
  for (const [name, spec] of Object.entries(PATHS)) {
    process.stdout.write(`\n  full SEAL path: ${name}  (${WARMUP} warm-up + ${REPS} measured)\n`);
    paths[name] = await steadyState(tokens, name, spec, REPS, WARMUP);
    const p = paths[name];
    process.stdout.write(
      `    e2e median ${p.endToEndMs.median} ms  p95 ${p.endToEndMs.p95} ms  |  `
      + `inference median ${p.inferenceMs.median} ms  |  remainder median ${p.remainderMs.median} ms  |  `
      + `${p.successes}/${p.requested} ok${p.drift && !p.drift.stationary ? '  (NON-STATIONARY)' : ''}\n`
    );
  }

  // ---- concurrency ----------------------------------------------------------
  process.stdout.write('\n  concurrency (ALLOW path)\n');
  const levels = [];
  for (const level of LEVELS) {
    const row = await concurrency(tokens, level, PATHS.allow);
    levels.push(row);
    process.stdout.write(
      `    level ${String(level).padStart(2)}  ok ${row.successes}/${row.requests}  `
      + `throughput ${row.throughputPerSec}/s  e2e median ${row.endToEndMs.median} ms  `
      + `p95 ${row.endToEndMs.p95} ms\n`
    );
  }

  // Only push to 50 if 20 was healthy, and say why if it is skipped.
  const twenty = levels.find((l) => l.level === 20);
  let fifty = null;
  if (twenty && twenty.failures === 0) {
    process.stdout.write('    level 20 was clean — extending to 50\n');
    fifty = await concurrency(tokens, 50, PATHS.allow);
    levels.push(fifty);
    process.stdout.write(
      `    level 50  ok ${fifty.successes}/${fifty.requests}  throughput ${fifty.throughputPerSec}/s  `
      + `e2e median ${fifty.endToEndMs.median} ms\n`
    );
  } else if (twenty) {
    process.stdout.write(`    level 50 skipped: level 20 had ${twenty.failures} failure(s)\n`);
  }

  // Drain anything the run left pending so the ledger is returned as found.
  const pend = await fabric.evaluate('audit', 'sp.north', 'AccessContract', 'QueryPendingEscalations');
  for (const d of pend) {
    const reviewer = d.explanation.reasonCode === 'SEALED_RECORD' ? 'judge.rana'
      : (d.subject.mspId === 'AuditMSP' && d.subject.role === 'sp' ? 'sp.south' : 'sp.north');
    await api('POST', `/access/${d.recordId}/${d.decisionId}/reject`,
      { token: tokens[reviewer], body: { note: 'performance run cleanup' } });
  }

  const allowPath = paths.allow;
  const payload = {
    metadata: metadata('EXP-04', {
      researchQuestion:
        'What latency and scalability overhead does SEAL add on top of model inference?',
      measuredStages: {
        T_model: 'inference latency from the signed inference descriptor',
        T_end_to_end: 'client-observed POST /access/llm-request round trip',
        T_remainder: 'T_end_to_end minus T_model; an UPPER BOUND on SEAL overhead',
      },
      notSeparatelyMeasured: [
        'T_context', 'T_validator', 'T_explanation', 'T_signature',
        'T_endorsement', 'T_commit',
      ],
      whyNotSeparated:
        'These stages run inside the AI decision service and the chaincode. Separating '
        + 'them requires timestamps in frozen code, which was not applied for this run. '
        + 'They are contained within T_remainder and are not reported individually.',
      pollingQuantisation:
        'The API polls the ledger for a decision every 250 ms, so end-to-end values are '
        + 'quantised at that granularity and slightly overstate true completion time.',
      concurrencyCaveat:
        'One local MLX model server serves every request. Concurrency figures therefore '
        + 'measure request queueing at a single inference endpoint together with the '
        + 'ledger path. They are not a measurement of Hyperledger Fabric scalability and '
        + 'must not be reported as such.',
      repetitions: REPS,
      warmupDiscarded: WARMUP,
    }),
    summary: {
      modelOnlyMs: modelStats,
      paths: Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, {
        successes: v.successes,
        failures: v.failures,
        decisions: v.decisions,
        coldStartMs: v.coldStartMs,
        endToEndMs: v.endToEndMs,
        inferenceMs: v.inferenceMs,
        remainderMs: v.remainderMs,
        drift: v.drift,
      }])),
      bottleneck: allowPath ? {
        modelMedianMs: modelStats.median,
        sealEndToEndMedianMs: allowPath.endToEndMs.median,
        sealRemainderMedianMs: allowPath.remainderMs.median,
        modelShareOfEndToEnd: ratio(allowPath.inferenceMs.median / allowPath.endToEndMs.median),
        remainderShareOfEndToEnd: ratio(allowPath.remainderMs.median / allowPath.endToEndMs.median),
      } : null,
      concurrency: levels.map((l) => ({
        level: l.level,
        successes: l.successes,
        failures: l.failures,
        throughputPerSec: l.throughputPerSec,
        meanMs: l.endToEndMs.mean,
        medianMs: l.endToEndMs.median,
        p95Ms: l.endToEndMs.p95,
        inferenceMedianMs: l.inferenceMs.median,
        remainderMedianMs: l.remainderMs.median,
        timeouts: l.timeouts,
      })),
    },
    runs: { modelOnlySamplesMs: modelSamples, paths, concurrency: levels },
  };

  writeJson('04-performance', payload);
  writeCsv('04-performance', [
    { measurement: 'model-only', ...modelStats },
    ...Object.entries(paths).map(([k, v]) => ({
      measurement: `seal-${k}`, n: v.endToEndMs.n,
      mean: v.endToEndMs.mean, median: v.endToEndMs.median, p95: v.endToEndMs.p95,
      sd: v.endToEndMs.sd, min: v.endToEndMs.min, max: v.endToEndMs.max,
      inferenceMedian: v.inferenceMs.median, remainderMedian: v.remainderMs.median,
    })),
    ...levels.map((l) => ({
      measurement: `concurrency-${l.level}`, n: l.successes,
      mean: l.endToEndMs.mean, median: l.endToEndMs.median, p95: l.endToEndMs.p95,
      throughputPerSec: l.throughputPerSec, failures: l.failures,
    })),
  ]);
  process.stdout.write('\n  wrote 04-performance.{json,csv}\n');
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`EXP-04 failed: ${error.stack}\n`);
  process.exit(1);
});
