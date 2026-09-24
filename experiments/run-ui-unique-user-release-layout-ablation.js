'use strict';

/** Distinct-user release ablation: each user opens a separate one-grant record. */

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api';
const LEVELS = Object.freeze([10, 25, 50, 75, 100]);
const REPETITIONS = 3;
const SETUP_PARALLELISM = Number(process.env.SETUP_PARALLELISM || 10);
const SETUP_COOLDOWN_MS = Number(process.env.SETUP_COOLDOWN_MS || 5000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1000);
const USER_PREFIX = process.env.USER_PREFIX || 'latuser';
const USERS = Object.freeze(Array.from({ length: 100 }, (_, index) => (
  `${USER_PREFIX}.${String(index + 1).padStart(3, '0')}`
)));
const EXPECTED_TOTAL = REPETITIONS * LEVELS.reduce((sum, value) => sum + value, 0);
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const shortStamp = runStamp.replace(/-/g, '').slice(0, 15);
const runId = `${runStamp}_ui_unique_user_release_layout_ablation`;
const runDir = path.join(REPO_ROOT, 'experiments', 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, 'experiment.log');

function log(message = '') {
  process.stdout.write(`${message}\n`);
  fs.appendFileSync(logPath, `${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapBounded(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) }, () => worker()
  ));
  return results;
}

async function api(method, urlPath, { token, body } = {}) {
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const responseText = await response.text();
    let json;
    try {
      json = JSON.parse(responseText);
    } catch (_error) {
      json = { success: false, error: `non-JSON response (${response.status})` };
    }
    return {
      status: response.status,
      ok: json.success === true,
      data: json.data,
      error: json.error || null,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: null,
      error: String(error.message || error),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  }
}

async function login(username) {
  const result = await api('POST', '/auth/login', { body: { username } });
  if (!result.ok || !result.data || !result.data.token) {
    throw new Error(`login ${username}: ${result.error || 'token missing'}`);
  }
  return result.data.token;
}

function recordIdFor(index) {
  return `UIAB-${shortStamp}-I${String(index).padStart(3, '0')}`;
}

async function createRecord(username, token, recordId) {
  const result = await api('POST', '/records', {
    token,
    body: {
      recordId,
      payload: {
        summary: 'synthetic per-user release-layout ablation record',
        generatedBy: 'experiments/run-ui-unique-user-release-layout-ablation.js',
      },
      meta: {
        caseId: 'CASE-2026-001',
        recordType: 'fir',
        sensitivityLevel: 'low',
        owningStation: 'PS-Central',
        jurisdiction: 'district-north',
      },
    },
  });
  if (!result.ok || !result.data || result.data.recordId !== recordId) {
    throw new Error(`record setup ${username}: ${result.error || 'unexpected response'}`);
  }
  return recordId;
}

async function createGrant(username, token, recordId) {
  const result = await api('POST', '/access/request', {
    token,
    body: { recordId, action: 'view', purpose: 'investigation' },
  });
  if (!result.ok || !result.data || result.data.decision !== 'allow') {
    throw new Error(`grant setup ${username}: ${result.error || JSON.stringify(result.data)}`);
  }
  return result.data.decisionId;
}

async function openRecord(username, token, recordId, expectedDecisionId) {
  const result = await api(
    'GET', `/records/${encodeURIComponent(recordId)}/payload`, { token }
  );
  const verified = result.ok && result.data && result.data.recordId === recordId
    && typeof result.data.contentHash === 'string'
    && result.data.grantedByDecision === expectedDecisionId;
  return {
    username,
    recordId,
    expectedDecisionId,
    grantedByDecision: result.data ? result.data.grantedByDecision : null,
    ok: verified,
    status: result.status,
    error: verified ? null : (result.error || 'unexpected authorized payload response'),
    elapsedMs: Number(result.elapsedMs.toFixed(2)),
  };
}

function rounded(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null : Number(value.toFixed(2));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(Math.max(Math.ceil(fraction * sorted.length) - 1, 0), sorted.length - 1)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    minMs: rounded(sorted[0]),
    p50Ms: rounded(percentile(sorted, 0.50)),
    meanMs: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function standardDeviation(values) {
  if (values.length < 2) return values.length === 1 ? 0 : null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1));
}

function csv(rows, columns) {
  return `${columns.join(',')}\n${rows.map(
    (row) => columns.map((column) => row[column] ?? '').join(',')
  ).join('\n')}\n`;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitOutput(args) {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_error) {
    return null;
  }
}

async function main() {
  const config = {
    experiment: 'distinct-user authorized-open release-layout ablation',
    runId,
    generatedAtUtc: new Date().toISOString(),
    apiBase: BASE,
    levels: LEVELS,
    repetitions: REPETITIONS,
    expectedMeasuredRequests: EXPECTED_TOTAL,
    identityPool: USERS,
    releaseLayout: 'one distinct record with one identity-bound grant per user',
    concurrencyMeaning: 'N simultaneous requests, N distinct users, and N distinct records',
    excludedSetup: ['login', '100 record submissions', '100 access grants', 'warm-up'],
    timingBoundary: 'client-observed HTTP request start through parsed JSON response',
    cooldownMs: COOLDOWN_MS,
    setupCooldownMs: SETUP_COOLDOWN_MS,
    setupParallelism: SETUP_PARALLELISM,
    stoppingRule: 'fixed 780-request sweep; stop on setup, identity, record, grant, or response failure',
    repository: {
      commit: gitOutput(['rev-parse', 'HEAD']),
      trackedStatus: gitOutput(['status', '--short', '--untracked-files=no']),
    },
    sourceSha256: {
      runner: sha256(__filename),
      experimentPlan: sha256(path.join(
        REPO_ROOT, 'experiments', 'plans', '20260828_unique_user_latency.md'
      )),
      recordChaincode: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'lib', 'recordContract.js'
      )),
    },
  };
  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const health = await api('GET', '/health');
  if (!health.ok) throw new Error(`backend unavailable: ${health.error}`);
  log(`Run: ${runId}`);
  log('Authenticating 100 distinct users (excluded) ...');
  const tokenEntries = await mapBounded(
    USERS, SETUP_PARALLELISM, async (username) => [username, await login(username)]
  );
  const tokens = Object.fromEntries(tokenEntries);
  await sleep(SETUP_COOLDOWN_MS);

  log('Creating 100 per-user synthetic records (excluded) ...');
  const recordEntries = await mapBounded(USERS, SETUP_PARALLELISM, async (username, index) => {
    const recordId = recordIdFor(index);
    await createRecord(username, tokens[username], recordId);
    return [username, recordId];
  });
  const records = Object.fromEntries(recordEntries);
  await sleep(SETUP_COOLDOWN_MS);

  log('Creating one identity-bound allow decision per record (excluded) ...');
  const grantEntries = await mapBounded(USERS, SETUP_PARALLELISM, async (username) => [
    username,
    await createGrant(username, tokens[username], records[username]),
  ]);
  const grants = Object.fromEntries(grantEntries);
  await sleep(SETUP_COOLDOWN_MS);

  log('Warm-up: five per-user authorized opens (excluded) ...');
  const warm = await Promise.all(USERS.slice(0, 5).map((username) => openRecord(
    username, tokens[username], records[username], grants[username]
  )));
  if (warm.some((sample) => !sample.ok)) throw new Error('release warm-up failed');
  await sleep(SETUP_COOLDOWN_MS);

  const rounds = [];
  const samples = [];
  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
    for (const level of LEVELS) {
      const usernames = USERS.slice(0, level);
      if (new Set(usernames).size !== level
          || new Set(usernames.map((username) => records[username])).size !== level) {
        throw new Error(`distinct identity/record guardrail failed at N=${level}`);
      }
      const started = process.hrtime.bigint();
      const batch = await Promise.all(usernames.map((username) => openRecord(
        username, tokens[username], records[username], grants[username]
      )));
      const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
      const successful = batch.filter((sample) => sample.ok);
      const round = {
        operation: 'release-per-user-record',
        repetition,
        concurrentUsers: level,
        distinctUsers: new Set(batch.map((sample) => sample.username)).size,
        distinctRecords: new Set(batch.map((sample) => sample.recordId)).size,
        attempted: batch.length,
        successful: successful.length,
        failed: batch.length - successful.length,
        ...stats(successful.map((sample) => sample.elapsedMs)),
        batchWallClockMs: rounded(wallMs),
        throughputRps: rounded(successful.length / (wallMs / 1000)),
      };
      rounds.push(round);
      samples.push(...batch.map((sample) => ({
        operation: round.operation,
        repetition,
        concurrentUsers: level,
        ...sample,
      })));
      log(`release R${repetition} users=${String(level).padStart(3)}: `
        + `p50=${String(round.p50Ms).padStart(7)} ms, `
        + `p95=${String(round.p95Ms).padStart(7)} ms`
        + (round.failed ? `, ${round.failed} failed` : ''));
      if (round.failed > 0) throw new Error(`release failure at R${repetition} N=${level}`);
      await sleep(COOLDOWN_MS);
    }
  }

  const summary = LEVELS.map((level) => {
    const matching = samples.filter((sample) => sample.concurrentUsers === level);
    const matchingRounds = rounds.filter((round) => round.concurrentUsers === level);
    const p50s = matchingRounds.map((round) => round.p50Ms);
    return {
      operation: 'release-per-user-record',
      concurrentUsers: level,
      batches: matchingRounds.length,
      attempted: matching.length,
      successful: matching.filter((sample) => sample.ok).length,
      failed: matching.filter((sample) => !sample.ok).length,
      ...stats(matching.filter((sample) => sample.ok).map((sample) => sample.elapsedMs)),
      batchP50MeanMs: rounded(p50s.reduce((sum, value) => sum + value, 0) / p50s.length),
      batchP50SdMs: rounded(standardDeviation(p50s)),
    };
  });
  const roundColumns = [
    'operation', 'repetition', 'concurrentUsers', 'distinctUsers', 'distinctRecords',
    'attempted', 'successful', 'failed', 'minMs', 'p50Ms', 'meanMs', 'p95Ms',
    'maxMs', 'batchWallClockMs', 'throughputRps',
  ];
  const summaryColumns = [
    'operation', 'concurrentUsers', 'batches', 'attempted', 'successful', 'failed',
    'minMs', 'p50Ms', 'meanMs', 'p95Ms', 'maxMs', 'batchP50MeanMs', 'batchP50SdMs',
  ];
  fs.writeFileSync(
    path.join(runDir, 'raw-samples.jsonl'),
    `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`
  );
  fs.writeFileSync(path.join(runDir, 'rounds.csv'), csv(rounds, roundColumns));
  fs.writeFileSync(path.join(runDir, 'summary.csv'), csv(summary, summaryColumns));
  fs.writeFileSync(
    path.join(runDir, 'setup.json'), `${JSON.stringify({ records, grants }, null, 2)}\n`
  );
  const report = {
    experiment: config.experiment,
    runId,
    config,
    result: {
      expectedRequests: EXPECTED_TOTAL,
      attemptedRequests: samples.length,
      successfulRequests: samples.filter((sample) => sample.ok).length,
      failedRequests: samples.filter((sample) => !sample.ok).length,
      fullSweepPassed: samples.length === EXPECTED_TOTAL && samples.every((sample) => sample.ok),
    },
    summary,
    limitation: 'sequential follow-up to the shared-record run; descriptive, not randomized',
  };
  fs.writeFileSync(
    path.join(runDir, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`
  );
  log(`Completed: ${report.result.successfulRequests}/${EXPECTED_TOTAL} requests succeeded.`);
  log(`Artifacts: ${runDir}`);
  const names = [
    'config.json', 'experiment.log', 'raw-samples.jsonl', 'rounds.csv',
    'summary.csv', 'setup.json', 'run-report.json',
  ];
  const manifest = {
    runId,
    generatedAtUtc: new Date().toISOString(),
    artifacts: Object.fromEntries(names.map((name) => [name, {
      bytes: fs.statSync(path.join(runDir, name)).size,
      sha256: sha256(path.join(runDir, name)),
    }])),
  };
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`
  );
}

main().catch((error) => {
  fs.writeFileSync(path.join(runDir, 'failure.json'), `${JSON.stringify({
    runId, failedAtUtc: new Date().toISOString(), error: String(error.stack || error),
  }, null, 2)}\n`);
  log(`FAILED: ${String(error.stack || error)}`);
  process.exitCode = 1;
});
