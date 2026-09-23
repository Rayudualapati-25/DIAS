#!/usr/bin/env node
'use strict';

/**
 * Current-DIAS concurrent-user performance experiment.
 *
 * One request per distinct signed-in user is launched at each concurrency level.
 * Recommendation readiness is observed from the backend's atomic off-chain
 * store, avoiding repeated HTTP polling (which itself creates Fabric audit
 * transactions).  Each result is then fetched once through the auditor API and
 * finalized with the recommendation-aligned decision.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createClient, sleep } = require('../../scripts/dias/acceptance-client');

const REPO = path.resolve(__dirname, '..', '..');
const USERS = [
  'insp.sharma', 'const.verma', 'io.krishnan', 'insp.singh',
  'dir.iyer', 'analyst.rao', 'pp.mehta', 'dc.nair',
  'judge.rana', 'clerk.das', 'sp.south', 'ci.central',
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = lower === upper ? ordered[lower]
    : ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
  return Number(value.toFixed(3));
}

function describe(values) {
  const good = values.filter(Number.isFinite);
  return {
    count: good.length,
    mean: good.length ? Number((good.reduce((a, b) => a + b, 0) / good.length).toFixed(3)) : null,
    p50: percentile(good, 0.5),
    p95: percentile(good, 0.95),
    max: good.length ? Number(Math.max(...good).toFixed(3)) : null,
  };
}

async function waitForReview(reviewDir, requestId, timeoutMs) {
  const file = path.join(reviewDir, `${requestId}.json`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (entry.recommendationState === 'ready') return entry;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (Date.now() > deadline) throw new Error(`recommendation ${requestId} not ready within ${timeoutMs} ms`);
    await sleep(100);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = args.url || 'http://127.0.0.1:3001/api';
  const reviewDir = path.resolve(args['review-dir'] || '');
  const outDir = path.resolve(REPO, args.out || 'experiments/runs/20260916_dias_concurrent_users');
  const levels = String(args.levels || '1,2,4,8,12').split(',').map(Number);
  const repetitions = Number(args.repetitions || 3);
  const timeoutMs = Number(args.timeout || 600000);
  if (!args['review-dir']) throw new Error('--review-dir is required');
  if (Math.max(...levels) > USERS.length) throw new Error(`maximum supported distinct-user level is ${USERS.length}`);
  if (fs.existsSync(path.join(outDir, 'concurrent-users.json'))) {
    throw new Error(`${path.relative(REPO, outDir)} already contains a completed run`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const rawFile = path.join(outDir, 'requests.jsonl');
  const client = createClient(apiUrl);

  // Pre-authenticate so measured time starts with the access request, not login.
  await Promise.all([...new Set([...USERS, 'sp.north'])].map((username) => client.token(username)));

  const runId = `overnight-${Date.now()}`;
  const rows = [];

  async function one(username, level, repetition, warmup = false) {
    const started = Date.now();
    const submitted = await client.submit(username, {
      recordId: 'REC-EVIDENCE-001',
      action: 'export',
      purpose: 'audit-review',
      justification: `Synthetic ${warmup ? 'warm-up' : 'concurrency'} measurement ${runId}; no operational access is requested.`,
    });
    const submittedAt = Date.now();
    if (submitted.status !== 202 || !submitted.data?.requestId) {
      throw new Error(`${username} submit returned ${submitted.status}: ${submitted.error || JSON.stringify(submitted.data)}`);
    }
    const requestId = submitted.data.requestId;
    const stored = await waitForReview(reviewDir, requestId, timeoutMs);
    const readyAt = Date.now();
    const reviewed = await client.review(requestId);
    if (reviewed.status !== 200 || reviewed.data?.recommendationState !== 'ready') {
      throw new Error(`${requestId} auditor view was not ready (${reviewed.status})`);
    }
    const recommendation = reviewed.data.recommendation || {};
    const valid = recommendation.generationStatus === 'OK'
      && ['ALLOW', 'DENY'].includes(recommendation.recommendation);
    const body = valid
      ? { decision: recommendation.recommendation === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY' }
      : { decision: 'FORCE_DENY', reason: 'No valid model recommendation was available during the performance experiment.' };
    const decisionStarted = Date.now();
    const decided = await client.decide(requestId, body);
    const finished = Date.now();
    if (decided.status !== 201) {
      throw new Error(`${requestId} decision returned ${decided.status}: ${decided.error}`);
    }
    const result = {
      runId, warmup, level, repetition, username, requestId,
      status: 'completed',
      recommendation: recommendation.recommendation || null,
      generationStatus: recommendation.generationStatus || null,
      adapterHash: recommendation.provenance?.adapterHash || null,
      requestCommitMs: submittedAt - started,
      requestToRecommendationReadyMs: readyAt - started,
      observedQueueAndInferenceMs: readyAt - submittedAt,
      modelInferenceMs: recommendation.provenance?.latencyMs?.inference ?? null,
      modelTotalMs: recommendation.provenance?.latencyMs?.total ?? null,
      decisionCommitMs: finished - decisionStarted,
      automatedEndToEndMs: finished - started,
      reviewStoreUpdatedAtUtc: stored.updatedAtUtc,
    };
    fs.appendFileSync(rawFile, `${JSON.stringify(result)}\n`);
    return result;
  }

  await one(USERS[0], 1, -1, true);
  for (const level of levels) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const batchStarted = Date.now();
      const settled = await Promise.allSettled(
        USERS.slice(0, level).map((username) => one(username, level, repetition))
      );
      const batchFinished = Date.now();
      const completed = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
      const failures = settled.filter((item) => item.status === 'rejected').map((item) => item.reason.message);
      rows.push({
        level, repetition, requested: level, completed: completed.length, failures,
        batchDurationMs: batchFinished - batchStarted,
        throughputCompletedWorkflowsPerSecond: Number((completed.length / ((batchFinished - batchStarted) / 1000)).toFixed(6)),
        requests: completed,
      });
      process.stdout.write(`users=${level} repetition=${repetition} completed=${completed.length}/${level} duration=${batchFinished - batchStarted}ms\n`);
    }
  }

  const summary = levels.map((level) => {
    const batches = rows.filter((row) => row.level === level);
    const requests = batches.flatMap((row) => row.requests);
    return {
      concurrentUsers: level,
      repetitions,
      requested: batches.reduce((sum, row) => sum + row.requested, 0),
      completed: requests.length,
      failures: batches.flatMap((row) => row.failures),
      requestCommitMs: describe(requests.map((row) => row.requestCommitMs)),
      requestToRecommendationReadyMs: describe(requests.map((row) => row.requestToRecommendationReadyMs)),
      modelInferenceMs: describe(requests.map((row) => row.modelInferenceMs)),
      decisionCommitMs: describe(requests.map((row) => row.decisionCommitMs)),
      automatedEndToEndMs: describe(requests.map((row) => row.automatedEndToEndMs)),
      batchThroughputCompletedWorkflowsPerSecond: describe(
        batches.map((row) => row.throughputCompletedWorkflowsPerSecond)
      ),
    };
  });
  const report = {
    artifactType: 'dias-current-system-concurrent-users',
    startedAtUtc: new Date(Number(runId.split('-')[1])).toISOString(),
    finishedAtUtc: new Date().toISOString(),
    host: { hostname: os.hostname(), platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, memoryBytes: os.totalmem() },
    apiUrl,
    reviewDir,
    design: {
      levels,
      repetitions,
      distinctSignedInUsers: true,
      warmupRequests: 1,
      modelQueue: 'The deployed backend intentionally serializes recommendations.',
      latencyBoundary: 'Automated request submission through recommendation readiness and auditor-decision commit; excludes human review time.',
    },
    summary,
    batches: rows,
    limitation: 'Single Apple-silicon host, synthetic burst workload, one local model worker, and automated auditor action. This is prototype capacity evidence, not a production scalability claim.',
  };
  fs.writeFileSync(path.join(outDir, 'concurrent-users.json'), `${JSON.stringify(report, null, 2)}\n`);

  const header = [
    'concurrent_users', 'repetitions', 'requested', 'completed', 'failures',
    'request_commit_p50_ms', 'request_commit_p95_ms',
    'recommendation_ready_p50_ms', 'recommendation_ready_p95_ms',
    'model_inference_p50_ms', 'model_inference_p95_ms',
    'decision_commit_p50_ms', 'decision_commit_p95_ms',
    'automated_end_to_end_p50_ms', 'automated_end_to_end_p95_ms',
    'throughput_mean_completed_workflows_per_s', 'throughput_p95_completed_workflows_per_s',
  ];
  const csvRows = summary.map((item) => [
    item.concurrentUsers, item.repetitions, item.requested, item.completed, item.failures.length,
    item.requestCommitMs.p50, item.requestCommitMs.p95,
    item.requestToRecommendationReadyMs.p50, item.requestToRecommendationReadyMs.p95,
    item.modelInferenceMs.p50, item.modelInferenceMs.p95,
    item.decisionCommitMs.p50, item.decisionCommitMs.p95,
    item.automatedEndToEndMs.p50, item.automatedEndToEndMs.p95,
    item.batchThroughputCompletedWorkflowsPerSecond.mean,
    item.batchThroughputCompletedWorkflowsPerSecond.p95,
  ]);
  const csv = `${[header, ...csvRows].map((row) => row.join(',')).join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'concurrent-users.csv'), csv);
  fs.mkdirSync(path.join(REPO, 'results', 'tables'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'results', 'tables', 'dias_concurrent_users.csv'), csv);
}

main().catch((error) => {
  console.error(`[concurrent-users] ${error.stack || error.message}`);
  process.exit(1);
});
