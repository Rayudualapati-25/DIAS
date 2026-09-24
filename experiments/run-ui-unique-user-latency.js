'use strict';

/**
 * Client-observed latency with one distinct enrolled Fabric identity per
 * simultaneous request. Setup (enrollment, login, assignment, grants, warm-up)
 * is excluded; the measured path is HTTP request start through parsed response.
 */

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const BASE = process.env.API_BASE || 'http://127.0.0.1:3001/api';
const parseList = (raw, fallback) => Object.freeze((raw ? raw.split(',') : fallback)
  .map((value) => Number(String(value).trim()))
  .filter((value) => Number.isInteger(value) && value > 0));
const LEVELS = parseList(process.env.LEVELS, [10, 25, 50, 75, 100]);
const REPETITIONS = Number(process.env.REPETITIONS || 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 1000);
const SETUP_COOLDOWN_MS = Number(process.env.SETUP_COOLDOWN_MS || 5000);
const SETUP_PARALLELISM = Number(process.env.SETUP_PARALLELISM || 10);
const OPERATIONS = Object.freeze((process.env.OPERATIONS || 'search,release,submit')
  .split(',').map((value) => value.trim()).filter(Boolean));
const USER_PREFIX = process.env.USER_PREFIX || 'latuser';
const SEARCH_CASE_ID = 'CASE-2026-002';
const FILE_CASE_ID = 'CASE-2026-001';
const EXPECTED_TOTAL = OPERATIONS.length * REPETITIONS
  * LEVELS.reduce((sum, level) => sum + level, 0);

if (!Number.isInteger(REPETITIONS) || REPETITIONS < 1) {
  throw new Error('REPETITIONS must be a positive integer');
}
if (!Number.isInteger(SETUP_PARALLELISM) || SETUP_PARALLELISM < 1) {
  throw new Error('SETUP_PARALLELISM must be a positive integer');
}
if (Math.max(...LEVELS) > 100) {
  throw new Error('the provisioned distinct-user pool contains 100 identities');
}
for (const operation of OPERATIONS) {
  if (!['search', 'release', 'submit'].includes(operation)) {
    throw new Error(`unknown operation '${operation}'`);
  }
}

const USERS = Object.freeze(Array.from({ length: 100 }, (_, index) => (
  `${USER_PREFIX}.${String(index + 1).padStart(3, '0')}`
)));
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `${runStamp}_ui_unique_user_latency`;
const runDir = path.join(REPO_ROOT, 'experiments', 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, 'experiment.log');

function log(message = '') {
  const line = String(message);
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(logPath, `${line}\n`);
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

function rounded(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null : Number(value.toFixed(2));
}

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1)];
}

function sampleStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.length
    ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
    : null;
  return {
    minMs: rounded(sorted[0]),
    p50Ms: rounded(percentile(sorted, 0.50)),
    meanMs: rounded(mean),
    p95Ms: rounded(percentile(sorted, 0.95)),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function standardDeviation(values) {
  if (values.length === 0) return null;
  if (values.length === 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function recordIdFor({ repetition, level, index, phase = 'measure' }) {
  const shortStamp = runStamp.replace(/-/g, '').slice(0, 15);
  return `UIUSR-${shortStamp}-${phase}-R${repetition}-N${level}-I${String(index).padStart(3, '0')}`;
}

async function searchCase(token) {
  const result = await api(
    'GET', `/records?caseId=${encodeURIComponent(SEARCH_CASE_ID)}`, { token }
  );
  const verified = result.ok && Array.isArray(result.data)
    && result.data.length === 1 && result.data[0].caseId === SEARCH_CASE_ID;
  return {
    ok: verified,
    status: result.status,
    elapsedMs: result.elapsedMs,
    observedResultCount: Array.isArray(result.data) ? result.data.length : null,
    error: verified ? null : (result.error || 'unexpected search result'),
  };
}

async function fileRecord({ username, token, recordId }) {
  const result = await api('POST', '/records', {
    token,
    body: {
      recordId,
      payload: {
        summary: 'synthetic distinct-user latency record; contains no real case content',
        generatedBy: 'experiments/run-ui-unique-user-latency.js',
      },
      meta: {
        caseId: FILE_CASE_ID,
        recordType: 'fir',
        sensitivityLevel: 'low',
        owningStation: 'PS-Central',
        jurisdiction: 'district-north',
      },
    },
  });
  const verified = result.ok && result.data && result.data.recordId === recordId;
  return {
    ok: verified,
    status: result.status,
    elapsedMs: result.elapsedMs,
    recordId,
    username,
    error: verified ? null : (result.error || 'unexpected create response'),
  };
}

async function openAuthorizedFile({ username, token, recordId, expectedDecisionId }) {
  const result = await api(
    'GET', `/records/${encodeURIComponent(recordId)}/payload`, { token }
  );
  const verified = result.ok && result.data && result.data.recordId === recordId
    && typeof result.data.contentHash === 'string'
    && result.data.grantedByDecision === expectedDecisionId;
  return {
    ok: verified,
    status: result.status,
    elapsedMs: result.elapsedMs,
    recordId,
    username,
    grantedByDecision: result.data ? result.data.grantedByDecision : null,
    expectedDecisionId,
    error: verified ? null : (result.error || 'unexpected authorized payload response'),
  };
}

function assertUniqueBatch(specs, level) {
  const count = new Set(specs.map((spec) => spec.username)).size;
  if (count !== level) {
    throw new Error(`identity guardrail failed: N=${level}, distinct usernames=${count}`);
  }
  return count;
}

async function releaseBatch(operation, repetition, level, tokens, accessRecordId, grants) {
  const specs = USERS.slice(0, level).map((username, index) => ({ index, username }));
  const distinctUsers = assertUniqueBatch(specs, level);
  const started = process.hrtime.bigint();
  let samples;

  if (operation === 'search') {
    samples = await Promise.all(specs.map(async (spec) => ({
      ...spec,
      ...(await searchCase(tokens[spec.username])),
    })));
  } else if (operation === 'submit') {
    samples = await Promise.all(specs.map(async (spec) => fileRecord({
      ...spec,
      token: tokens[spec.username],
      recordId: recordIdFor({ repetition, level, index: spec.index }),
    })));
  } else if (operation === 'release') {
    samples = await Promise.all(specs.map(async (spec) => openAuthorizedFile({
      ...spec,
      token: tokens[spec.username],
      recordId: accessRecordId,
      expectedDecisionId: grants[spec.username],
    })));
  }

  const wallClockMs = Number(process.hrtime.bigint() - started) / 1e6;
  const successful = samples.filter((sample) => sample.ok);
  const round = {
    operation,
    repetition,
    concurrentUsers: level,
    distinctUsers,
    attempted: samples.length,
    successful: successful.length,
    failed: samples.length - successful.length,
    ...sampleStats(successful.map((sample) => sample.elapsedMs)),
    batchWallClockMs: rounded(wallClockMs),
    throughputRps: rounded(successful.length / (wallClockMs / 1000)),
  };
  const failureText = round.failed ? `, ${round.failed} failed` : '';
  log(`${operation.padEnd(7)} R${repetition} users=${String(level).padStart(3)}: `
    + `p50=${String(round.p50Ms).padStart(7)} ms, `
    + `p95=${String(round.p95Ms).padStart(7)} ms${failureText}`);

  return {
    round,
    samples: samples.map((sample) => ({
      operation,
      repetition,
      concurrentUsers: level,
      ...sample,
      elapsedMs: rounded(sample.elapsedMs),
    })),
  };
}

function csv(rows, columns) {
  const quote = (value) => {
    const raw = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
  };
  return `${columns.join(',')}\n${rows.map(
    (row) => columns.map((key) => quote(row[key])).join(',')
  ).join('\n')}\n`;
}

function aggregate(rounds, samples) {
  const rows = [];
  for (const operation of OPERATIONS) {
    for (const level of LEVELS) {
      const matchingSamples = samples.filter((sample) => (
        sample.operation === operation && sample.concurrentUsers === level
      ));
      const successful = matchingSamples.filter((sample) => sample.ok);
      const matchingRounds = rounds.filter((round) => (
        round.operation === operation && round.concurrentUsers === level
      ));
      const p50s = matchingRounds.filter((round) => round.p50Ms !== null)
        .map((round) => round.p50Ms);
      rows.push({
        operation,
        concurrentUsers: level,
        batches: matchingRounds.length,
        attempted: matchingSamples.length,
        successful: successful.length,
        failed: matchingSamples.length - successful.length,
        ...sampleStats(successful.map((sample) => sample.elapsedMs)),
        batchP50MeanMs: rounded(p50s.reduce((sum, value) => sum + value, 0) / p50s.length),
        batchP50SdMs: rounded(standardDeviation(p50s)),
      });
    }
  }
  return rows;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitOutput(args) {
  try {
    return childProcess.execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_error) {
    return null;
  }
}

function dockerImageSnapshot() {
  try {
    const output = childProcess.execFileSync('docker', [
      'ps', '--format', '{{.Names}}\t{{.Image}}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return output.split('\n').filter((line) => (
      /^(peer0\.|orderer\.|couchdb-)/.test(line)
    )).sort();
  } catch (_error) {
    return null;
  }
}

async function main() {
  const selectedUsers = USERS.slice(0, Math.max(...LEVELS));
  const config = {
    experiment: 'live interactive latency with distinct enrolled Fabric users',
    runId,
    generatedAtUtc: new Date().toISOString(),
    apiBase: BASE,
    levels: LEVELS,
    operations: OPERATIONS,
    repetitions: REPETITIONS,
    expectedMeasuredRequests: EXPECTED_TOTAL,
    cooldownMs: COOLDOWN_MS,
    setupCooldownMs: SETUP_COOLDOWN_MS,
    setupParallelism: SETUP_PARALLELISM,
    searchCaseId: SEARCH_CASE_ID,
    expectedSearchResults: 1,
    fileCaseId: FILE_CASE_ID,
    identityPoolSize: selectedUsers.length,
    identityPool: selectedUsers,
    concurrencyMeaning: 'N simultaneous HTTP requests signed by N distinct enrolled Fabric users',
    reuseAcrossBatches: 'the same pool of 100 users is reused across repetitions and levels',
    measuredPaths: {
      search: 'GET /records?caseId -> RecordContract.QueryRecords',
      submit: 'POST /records -> vault save + RecordContract.CreateCaseRecord + commit',
      release: 'GET /records/:id/payload -> RecordContract.AuthorizeRecordRead + vault read + SHA-256 check',
    },
    excludedSetup: [
      'CA registration/enrollment', 'on-chain user creation', 'case assignment',
      'login', 'per-user access-decision creation', 'five warm-up requests per operation',
    ],
    timingBoundary: 'client-observed HTTP request start through parsed JSON response',
    order: 'all search rounds, then all release rounds, then all submit rounds',
    afterResponseAuditLogging: 'enabled in backend; audit submissions occur after responses and may contribute background load',
    stoppingRule: 'fixed sweep; stop on prerequisite, unique-identity, access, or response correctness failure',
    invocation: {
      command: 'node experiments/run-ui-unique-user-latency.js',
      overrides: Object.fromEntries([
        'API_BASE', 'LEVELS', 'REPETITIONS', 'COOLDOWN_MS', 'SETUP_COOLDOWN_MS',
        'SETUP_PARALLELISM', 'OPERATIONS', 'USER_PREFIX',
      ].filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])),
    },
    repository: {
      commit: gitOutput(['rev-parse', 'HEAD']),
      trackedStatus: gitOutput(['status', '--short', '--untracked-files=no']),
    },
    sourceSha256: {
      runner: sha256(__filename),
      experimentPlan: sha256(path.join(
        REPO_ROOT, 'experiments', 'plans', '20260828_unique_user_latency.md'
      )),
      backendRecordRoutes: sha256(path.join(
        REPO_ROOT, 'backend', 'src', 'routes', 'records.js'
      )),
      fabricGateway: sha256(path.join(REPO_ROOT, 'backend', 'src', 'fabric', 'gateway.js')),
      accessChaincode: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'lib', 'accessContract.js'
      )),
      recordChaincode: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'lib', 'recordContract.js'
      )),
      couchDbCaseIndex: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'META-INF', 'statedb', 'couchdb',
        'indexes', 'indexDocTypeCaseId.json'
      )),
    },
  };
  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(
    path.join(runDir, 'users.json'), `${JSON.stringify(selectedUsers, null, 2)}\n`
  );

  const health = await api('GET', '/health');
  if (!health.ok) throw new Error(`backend unavailable at ${BASE}: ${health.error}`);
  log(`Run: ${runId}`);
  log(`Output: ${runDir}`);
  log(`Authenticating ${selectedUsers.length} distinct enrolled identities (excluded) ...`);
  const loginResults = await mapBounded(
    selectedUsers, SETUP_PARALLELISM, async (username) => [username, await login(username)]
  );
  const tokens = Object.fromEntries(loginResults);
  await sleep(SETUP_COOLDOWN_MS);

  const casesResult = await api('GET', '/cases', { token: tokens[selectedUsers[0]] });
  if (!casesResult.ok) throw new Error(`case preflight failed: ${casesResult.error}`);

  if (OPERATIONS.includes('search')) {
    const preflight = await searchCase(tokens[selectedUsers[0]]);
    if (!preflight.ok) throw new Error(`search preflight failed: ${preflight.error}`);
    log('Warm-up: five distinct-user searches (excluded) ...');
    const warm = await Promise.all(selectedUsers.slice(0, 5).map(
      (username) => searchCase(tokens[username])
    ));
    if (warm.some((sample) => !sample.ok)) throw new Error('search warm-up failed');
  }

  let accessRecordId = null;
  const grants = {};
  if (OPERATIONS.includes('release') || OPERATIONS.includes('submit')) {
    log('Warm-up: five distinct-user record submissions (excluded) ...');
    const warmRecords = await Promise.all(selectedUsers.slice(0, 5).map(
      (username, index) => fileRecord({
        username,
        token: tokens[username],
        recordId: recordIdFor({ repetition: 0, level: 5, index, phase: 'warm' }),
      })
    ));
    const failed = warmRecords.filter((sample) => !sample.ok);
    if (failed.length > 0) throw new Error(`record warm-up failed: ${JSON.stringify(failed)}`);
    accessRecordId = warmRecords[0].recordId;
  }

  if (OPERATIONS.includes('release')) {
    log(`Creating ${selectedUsers.length} identity-bound allow decisions (excluded) ...`);
    const grantResults = await mapBounded(
      selectedUsers,
      SETUP_PARALLELISM,
      async (username) => {
        const result = await api('POST', '/access/request', {
          token: tokens[username],
          body: { recordId: accessRecordId, action: 'view', purpose: 'investigation' },
        });
        if (!result.ok || !result.data || result.data.decision !== 'allow') {
          throw new Error(
            `access setup ${username}: ${result.error || JSON.stringify(result.data)}`
          );
        }
        return [username, result.data.decisionId];
      }
    );
    Object.assign(grants, Object.fromEntries(grantResults));
    await sleep(SETUP_COOLDOWN_MS);
    log('Warm-up: five distinct-user authorized opens (excluded) ...');
    const releaseWarm = await Promise.all(selectedUsers.slice(0, 5).map(
      (username) => openAuthorizedFile({
        username,
        token: tokens[username],
        recordId: accessRecordId,
        expectedDecisionId: grants[username],
      })
    ));
    const failed = releaseWarm.filter((sample) => !sample.ok);
    if (failed.length > 0) {
      throw new Error(`authorized-open warm-up failed: ${JSON.stringify(failed)}`);
    }
    log(`Authorized synthetic record: ${accessRecordId}`);
  }
  await sleep(SETUP_COOLDOWN_MS);
  log('');

  const rounds = [];
  const samples = [];
  const partialRawPath = path.join(runDir, 'raw-samples.partial.jsonl');
  const partialRoundsPath = path.join(runDir, 'rounds.partial.jsonl');
  for (const operation of OPERATIONS) {
    log(`${operation.toUpperCase()} MEASUREMENTS`);
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      for (const level of LEVELS) {
        const result = await releaseBatch(
          operation, repetition, level, tokens, accessRecordId, grants
        );
        rounds.push(result.round);
        samples.push(...result.samples);
        fs.appendFileSync(
          partialRoundsPath, `${JSON.stringify(result.round)}\n`
        );
        fs.appendFileSync(
          partialRawPath,
          `${result.samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`
        );
        if (result.round.failed > 0) {
          throw new Error(
            `correctness guardrail failed in ${operation} R${repetition} N=${level}`
          );
        }
        await sleep(COOLDOWN_MS);
      }
    }
    log('');
  }

  const summary = aggregate(rounds, samples);
  const environment = {
    recordedAtUtc: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    containerImages: dockerImageSnapshot(),
    topology: {
      channel: 'crimechannel',
      chaincode: 'crimerecords',
      organizations: 5,
      peersPerOrganization: 1,
      orderer: 'single-node Raft',
      stateDatabase: 'CouchDB',
      deployment: 'single-host local Docker; not a geographically distributed benchmark',
    },
    observedCases: casesResult.data.map((item) => item.caseId).sort(),
  };
  const roundColumns = [
    'operation', 'repetition', 'concurrentUsers', 'distinctUsers', 'attempted',
    'successful', 'failed', 'minMs', 'p50Ms', 'meanMs', 'p95Ms', 'maxMs',
    'batchWallClockMs', 'throughputRps',
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
    path.join(runDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(runDir, 'access-setup.json'),
    `${JSON.stringify({
      recordId: accessRecordId,
      grants,
      grantCount: Object.keys(grants).length,
      excludedFromMeasurements: true,
    }, null, 2)}\n`
  );

  const successCount = samples.filter((sample) => sample.ok).length;
  const uniqueChecks = rounds.every((round) => round.distinctUsers === round.concurrentUsers);
  const report = {
    experiment: config.experiment,
    runId,
    generatedAtUtc: new Date().toISOString(),
    config,
    environment,
    result: {
      expectedRequests: EXPECTED_TOTAL,
      attemptedRequests: samples.length,
      successfulRequests: successCount,
      failedRequests: samples.length - successCount,
      uniqueIdentityGuardrailPassed: uniqueChecks,
      fullSweepPassed: samples.length === EXPECTED_TOTAL
        && successCount === EXPECTED_TOTAL && uniqueChecks,
    },
    summary,
    limitations: [
      'single-host local Fabric deployment',
      'three batches per point do not establish a capacity threshold or confidence interval',
      'the same synthetic users are reused across batches and concurrency levels',
      'operation groups are sequential rather than randomized',
      'after-response audit transactions can create overlapping background load',
      'comparison with the earlier five-identity run is cross-run and descriptive, not causal',
    ],
  };
  fs.writeFileSync(
    path.join(runDir, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`
  );
  log(`Completed: ${successCount}/${EXPECTED_TOTAL} measured requests succeeded.`);
  log(`Identity guardrail: ${uniqueChecks ? 'passed' : 'failed'}.`);
  log(`Artifacts: ${runDir}`);

  const artifactNames = [
    'config.json', 'users.json', 'experiment.log', 'raw-samples.partial.jsonl',
    'rounds.partial.jsonl', 'raw-samples.jsonl', 'rounds.csv', 'summary.csv',
    'environment.json', 'access-setup.json', 'run-report.json',
  ];
  const manifest = {
    runId,
    generatedAtUtc: new Date().toISOString(),
    artifacts: Object.fromEntries(artifactNames.map((name) => [name, {
      bytes: fs.statSync(path.join(runDir, name)).size,
      sha256: sha256(path.join(runDir, name)),
    }])),
  };
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`
  );
  if (!report.result.fullSweepPassed) process.exitCode = 1;
}

let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) return;
  interrupted = true;
  log('Interrupted; partial JSONL artifacts have been retained.');
  process.exit(130);
});

main().catch((error) => {
  const failure = {
    runId,
    failedAtUtc: new Date().toISOString(),
    error: String(error.stack || error),
  };
  fs.writeFileSync(
    path.join(runDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`
  );
  log(`FAILED: ${failure.error}`);
  process.exitCode = 1;
});
