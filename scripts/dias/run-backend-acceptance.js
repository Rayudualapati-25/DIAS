#!/usr/bin/env node
'use strict';

/**
 * Live DIAS acceptance run through the application backend.
 *
 * Nothing is mocked. Requests go through the backend HTTP API exactly as the web
 * interface sends them; the backend calls the real LLM and keeps its
 * recommendation off-chain; every ledger claim is checked against committed
 * Fabric state read back through the API. A second backend with an unreachable
 * model endpoint is started only for the no-recommendation scenario.
 *
 * Needs the DIAS channel and chaincode, seeded users and records, the model
 * server, and the backend at DIAS_API_URL (default http://localhost:3001/api).
 *
 *   node scripts/dias/run-backend-acceptance.js --out experiments/runs/<date>_dias_backend_llm_acceptance_<time>
 *
 * The output directory must not already hold a run: earlier evidence is never
 * overwritten.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createClient, sleep } = require('./acceptance-client');
const flow = require('./acceptance-scenarios');
const safeguards = require('./acceptance-safeguards');

const REPO = path.resolve(__dirname, '..', '..');
const API_URL = process.env.DIAS_API_URL || 'http://localhost:3001/api';
const OFFLINE_PORT = Number(process.env.DIAS_OFFLINE_BACKEND_PORT || 3002);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : null;
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`backend at ${url} did not become healthy`);
    await sleep(500);
  }
}

/** A second backend on the same ledger whose model endpoint cannot be reached. */
async function startOfflineModelBackend(outDir) {
  const logFile = fs.openSync(path.join(outDir, 'offline-model-backend.log'), 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'backend', 'src', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(OFFLINE_PORT),
      CORS_ORIGIN: `http://localhost:${OFFLINE_PORT}`,
      DIAS_MODEL_URL: 'http://127.0.0.1:9/v1',
      DIAS_MODEL_TIMEOUT_MS: '10000',
      DIAS_REVIEW_STORE_DIR: path.join(outDir, 'offline-model-review-store'),
    },
    stdio: ['ignore', logFile, logFile],
  });
  const url = `http://localhost:${OFFLINE_PORT}/api`;
  await waitForHealth(url, 60000);
  return { url, stop: () => child.kill('SIGTERM') };
}

/** A client that remembers every request id it raised. */
function recordingClient(client, requestIds) {
  return {
    ...client,
    async submit(username, body) {
      const response = await client.submit(username, body);
      if (response.data && response.data.requestId) requestIds.push(response.data.requestId);
      return response;
    },
  };
}

function writeReport(outDir, report) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.scenarios.map((item) => [
    item.id, `"${item.title}"`, item.status,
    item.checks.filter((c) => c.ok).length, item.checks.length,
  ].join(','));
  fs.writeFileSync(path.join(outDir, 'scenarios.csv'),
    `id,title,status,checks_passed,checks_total\n${rows.join('\n')}\n`);
}

async function runFlow(client, record) {
  const first = await flow.requestLog(client, flow.SPECS.assigned);
  record(first.result);
  const firstReview = await flow.backendRecommendation(client, first.requestId);
  record(firstReview.result);
  const candidates = [
    { spec: flow.SPECS.assigned, requestId: first.requestId, review: firstReview.review },
    await flow.submitForReview(client, flow.SPECS.crossDistrict),
  ];
  const allow = candidates.find((item) => flow.llmValue(item.review) === 'ALLOW');
  const deny = candidates.find((item) => flow.llmValue(item.review) === 'DENY');
  record(await flow.agreedGrant(client, allow));
  const override = await flow.overrideCreatesAuthorization(client, deny);
  record(override.result);
  const denySpec = deny ? deny.spec : null;
  record(await flow.exactRepeat(client, denySpec, override.authorization));
  const misses = await flow.nearMisses(client, denySpec, override.authorization);
  record(misses.result);
  const closed = await flow.closePending(client, misses.pending);
  record(closed.result);
  record(await flow.overrideAllow(client, closed.overriddenAllows, allow && allow.spec));
  for (const leftover of candidates.filter((item) => item !== allow && item !== deny)) {
    await flow.closeOne(client, { label: 'unused candidate', requestId: leftover.requestId });
  }
  return { deny, override, denySpec };
}

/** A fresh output directory; refuses one that already holds a run's evidence. */
function newRunDir(requested) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  const [date, time] = stamp.split('T');
  const outDir = path.resolve(REPO, requested || `experiments/runs/${date}_dias_backend_llm_acceptance_${time}`);
  const existing = ['acceptance.json', 'scenarios.csv', 'runner.log', 'offline-model-review-store']
    .filter((name) => fs.existsSync(path.join(outDir, name)));
  if (existing.length > 0) {
    throw new Error(`${path.relative(REPO, outDir)} already holds a run (${existing.join(', ')}); `
      + 'pass a new --out directory so the earlier evidence is kept');
  }
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

/** Print a line and keep it in the run's runner.log, so a partial run still leaves a log. */
function runnerLog(outDir) {
  const file = path.join(outDir, 'runner.log');
  return (line) => {
    console.log(line);
    fs.appendFileSync(file, `${line}\n`);
  };
}

/** The scenarios use the demo case files; a fresh install has none. */
async function requireDemoData(client) {
  const found = await client.api('GET', '/records/lookup/REC-FIR-001', { username: 'insp.sharma' });
  if (found.status !== 200) {
    throw new Error('PRECONDITION: the demo case files are missing (REC-FIR-001). '
      + 'Run "make dias-demo-data" and try again.');
  }
}

async function main() {
  const outDir = newRunDir(argValue('--out'));
  const log = runnerLog(outDir);
  await waitForHealth(API_URL, 10000);
  const requestIds = [];
  const client = recordingClient(createClient(API_URL), requestIds);
  await requireDemoData(client);
  const scenarios = [];
  const record = (result) => {
    scenarios.push(result);
    log(`${result.status.padEnd(13)} ${result.id}  ${result.title}`);
    for (const failed of result.checks.filter((item) => !item.ok)) log(`      x ${failed.name}: ${failed.detail}`);
  };
  const startedAtUtc = new Date().toISOString();

  const { deny, override, denySpec } = await runFlow(client, record);
  record(await safeguards.revocationAndExpiry(client, denySpec, override.authorization));
  record(await safeguards.selfDecision(client));
  record(await safeguards.changedFacts(client));
  const offline = await startOfflineModelBackend(outDir);
  try {
    record(await safeguards.noRecommendation(recordingClient(createClient(offline.url), requestIds)));
  } finally {
    offline.stop();
  }
  record(await safeguards.accessLog(client, deny && deny.requestId, 'NOT_AGREED'));
  record(await safeguards.noLlmOnLedger(client, requestIds));

  const count = (status) => scenarios.filter((item) => item.status === status).length;
  const report = {
    artifactType: 'dias-backend-llm-acceptance',
    startedAtUtc,
    finishedAtUtc: new Date().toISOString(),
    apiUrl: API_URL,
    summary: { pass: count('PASS'), fail: count('FAIL'), notExercised: count('NOT EXERCISED'), total: scenarios.length },
    checks: {
      passed: scenarios.flatMap((item) => item.checks).filter((item) => item.ok).length,
      total: scenarios.flatMap((item) => item.checks).length,
    },
    requestIds,
    scenarios,
  };
  writeReport(outDir, report);
  log(`\n${report.summary.pass}/${report.summary.total} scenarios pass, `
    + `${report.checks.passed}/${report.checks.total} checks; written to ${path.relative(REPO, outDir)}`);
  process.exitCode = report.summary.fail === 0 && report.summary.notExercised === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`[acceptance] ${error.stack || error.message}`);
  process.exit(1);
});
