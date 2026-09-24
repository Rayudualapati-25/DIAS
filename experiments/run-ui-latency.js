'use strict';

/**
 * Live client-observed latency study for the three interactions shown in the
 * paper: search case files, file a record, and open an authorized case file.
 *
 * Each concurrency level releases N HTTP requests together.  The measurements
 * therefore include the browser-facing REST path and Fabric Gateway work.  The
 * file-release path additionally includes AuthorizeRecordRead, agency-vault
 * retrieval, and the backend's SHA-256 integrity check.  It is not an isolated
 * chaincode-compute benchmark.
 *
 * Prerequisites: a seeded local Fabric network and the backend on API_BASE.
 * Usage: node experiments/run-ui-latency.js
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
const OPERATIONS = Object.freeze((process.env.OPERATIONS || 'search,release,submit')
  .split(',').map((value) => value.trim()).filter(Boolean));
const SEARCH_CASE_ID = 'CASE-2026-002';
const FILE_CASE_ID = 'CASE-2026-001';

// These are enrolled identities, not a claim of N distinct officers.  Sessions
// cycle through this fixed pool, matching the prototype's local deployment.
const FILING_IDENTITIES = Object.freeze([
  'insp.sharma', 'sho.reddy', 'const.verma', 'io.krishnan', 'insp.singh',
]);
const ACCESS_IDENTITY = 'insp.sharma';

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `${runStamp}_ui_interaction_latency`;
const runDir = path.join(REPO_ROOT, 'experiments', 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, 'experiment.log');

const logLines = [];
function log(message = '') {
  const line = String(message);
  logLines.push(line);
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(logPath, `${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
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
  if (!result.ok) throw new Error(`login ${username}: ${result.error}`);
  return result.data.token;
}

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1)];
}

function rounded(value) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null : Number(value.toFixed(2));
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

function identityFor(index) {
  return FILING_IDENTITIES[index % FILING_IDENTITIES.length];
}

function recordIdFor({ repetition, level, index, phase = 'measure' }) {
  const shortStamp = runStamp.replace(/-/g, '').slice(0, 15);
  return `UILAT-${shortStamp}-${phase}-R${repetition}-N${level}-I${String(index).padStart(3, '0')}`;
}

async function searchCase(token) {
  const result = await api('GET', `/records?caseId=${encodeURIComponent(SEARCH_CASE_ID)}`, { token });
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
        summary: 'synthetic UI latency record; contains no real case content',
        generatedBy: 'experiments/run-ui-latency.js',
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

async function openAuthorizedFile(token, recordId) {
  const result = await api('GET', `/records/${encodeURIComponent(recordId)}/payload`, { token });
  const verified = result.ok && result.data && result.data.recordId === recordId
    && typeof result.data.contentHash === 'string'
    && typeof result.data.grantedByDecision === 'string';
  return {
    ok: verified,
    status: result.status,
    elapsedMs: result.elapsedMs,
    recordId,
    grantedByDecision: verified ? result.data.grantedByDecision : null,
    error: verified ? null : (result.error || 'unexpected payload response'),
  };
}

async function releaseBatch(operation, repetition, level, tokens, accessRecordId) {
  const specs = Array.from({ length: level }, (_, index) => ({
    index,
    username: identityFor(index),
  }));
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
    samples = await Promise.all(specs.map(async (spec) => ({
      ...spec,
      username: ACCESS_IDENTITY,
      ...(await openAuthorizedFile(tokens[ACCESS_IDENTITY], accessRecordId)),
    })));
  } else {
    throw new Error(`unknown operation: ${operation}`);
  }

  const wallClockMs = Number(process.hrtime.bigint() - started) / 1e6;
  const successful = samples.filter((sample) => sample.ok);
  const stats = sampleStats(successful.map((sample) => sample.elapsedMs));
  const round = {
    operation,
    repetition,
    concurrentSessions: level,
    attempted: samples.length,
    successful: successful.length,
    failed: samples.length - successful.length,
    ...stats,
    batchWallClockMs: rounded(wallClockMs),
    throughputRps: rounded(successful.length / (wallClockMs / 1000)),
  };

  const failureText = round.failed ? `, ${round.failed} failed` : '';
  log(`${operation.padEnd(7)} R${repetition} N=${String(level).padStart(3)}: `
    + `p50=${String(round.p50Ms).padStart(7)} ms, `
    + `p95=${String(round.p95Ms).padStart(7)} ms${failureText}`);
  return {
    round,
    samples: samples.map((sample) => ({
      operation,
      repetition,
      concurrentSessions: level,
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
  return `${columns.join(',')}\n${rows.map((row) => columns.map((key) => quote(row[key])).join(','))
    .join('\n')}\n`;
}

function aggregate(rounds, samples) {
  const rows = [];
  for (const operation of OPERATIONS) {
    for (const level of LEVELS) {
      const matchingSamples = samples.filter((sample) => sample.operation === operation
        && sample.concurrentSessions === level);
      const successful = matchingSamples.filter((sample) => sample.ok);
      const matchingRounds = rounds.filter((round) => round.operation === operation
        && round.concurrentSessions === level);
      const p50s = matchingRounds.filter((round) => round.p50Ms !== null)
        .map((round) => round.p50Ms);
      const stats = sampleStats(successful.map((sample) => sample.elapsedMs));
      rows.push({
        operation,
        concurrentSessions: level,
        batches: matchingRounds.length,
        attempted: matchingSamples.length,
        successful: successful.length,
        failed: matchingSamples.length - successful.length,
        ...stats,
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
  } catch {
    return null;
  }
}

function dockerImageSnapshot() {
  try {
    const output = childProcess.execFileSync('docker', [
      'ps', '--format', '{{.Names}}\t{{.Image}}',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.split('\n').filter((line) => (
      /^(peer0\.|orderer\.|couchdb-)/.test(line)
    )).sort();
  } catch {
    return null;
  }
}

async function main() {
  const config = {
    runId,
    generatedAtUtc: new Date().toISOString(),
    apiBase: BASE,
    levels: LEVELS,
    operations: OPERATIONS,
    repetitions: REPETITIONS,
    cooldownMs: COOLDOWN_MS,
    searchCaseId: SEARCH_CASE_ID,
    expectedSearchResults: 1,
    fileCaseId: FILE_CASE_ID,
    identityPool: FILING_IDENTITIES,
    accessIdentity: ACCESS_IDENTITY,
    concurrencyMeaning: 'N simultaneous HTTP client sessions; identities are reused from the fixed pool',
    measuredPaths: {
      search: 'GET /records?caseId -> RecordContract.QueryRecords',
      submit: 'POST /records -> vault save + RecordContract.CreateCaseRecord + commit',
      release: 'GET /records/:id/payload -> RecordContract.AuthorizeRecordRead + vault read + SHA-256 check',
    },
    timingBoundary: 'client-observed HTTP request start through parsed JSON response',
    warmup: 'five requests per operation, excluded',
    order: 'all search rounds, then all release rounds, then all submit rounds',
    invocation: {
      command: 'node experiments/run-ui-latency.js',
      overrides: Object.fromEntries([
        'API_BASE', 'LEVELS', 'REPETITIONS', 'COOLDOWN_MS', 'OPERATIONS',
      ].filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])),
    },
    repository: {
      commit: gitOutput(['rev-parse', 'HEAD']),
      trackedStatus: gitOutput(['status', '--short', '--untracked-files=no']),
    },
    sourceSha256: {
      runner: sha256(__filename),
      backendRecordRoutes: sha256(path.join(
        REPO_ROOT, 'backend', 'src', 'routes', 'records.js')),
      fabricGateway: sha256(path.join(REPO_ROOT, 'backend', 'src', 'fabric', 'gateway.js')),
      recordChaincode: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'lib', 'recordContract.js')),
      couchDbCaseIndex: sha256(path.join(
        REPO_ROOT, 'chaincode', 'crimerecords', 'META-INF', 'statedb', 'couchdb',
        'indexes', 'indexDocTypeCaseId.json')),
    },
  };
  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const health = await api('GET', '/health');
  if (!health.ok) throw new Error(`backend unavailable at ${BASE}: ${health.error}`);

  log(`Run: ${runId}`);
  log(`Output: ${runDir}`);
  log('Authenticating the fixed local identity pool ...');
  const loginEntries = await Promise.all(FILING_IDENTITIES.map(async (username) => (
    [username, await login(username)]
  )));
  const tokens = Object.fromEntries(loginEntries);

  const casesResult = await api('GET', '/cases', { token: tokens[ACCESS_IDENTITY] });
  if (!casesResult.ok) throw new Error(`case preflight failed: ${casesResult.error}`);
  if (OPERATIONS.includes('search')) {
    const searchPreflight = await searchCase(tokens[ACCESS_IDENTITY]);
    if (!searchPreflight.ok) throw new Error(`search preflight failed: ${searchPreflight.error}`);
    log('Warm-up: case-file search (five requests, excluded) ...');
    await Promise.all(Array.from({ length: 5 }, (_, index) => searchCase(
      tokens[identityFor(index)])));
  }

  let accessRecordId = null;
  let grant = null;
  if (OPERATIONS.includes('submit') || OPERATIONS.includes('release')) {
    log('Warm-up: record submission (five requests, excluded) ...');
    const warmRecords = await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const username = identityFor(index);
      return fileRecord({
        username,
        token: tokens[username],
        recordId: recordIdFor({ repetition: 0, level: 5, index, phase: 'warm' }),
      });
    }));
    if (warmRecords.some((sample) => !sample.ok)) {
      throw new Error(`record warm-up failed: ${JSON.stringify(warmRecords.filter((s) => !s.ok))}`);
    }
    accessRecordId = warmRecords[0].recordId;
  }

  if (OPERATIONS.includes('release')) {
    grant = await api('POST', '/access/request', {
      token: tokens[ACCESS_IDENTITY],
      body: { recordId: accessRecordId, action: 'view', purpose: 'investigation' },
    });
    if (!grant.ok || !grant.data || grant.data.decision !== 'allow') {
      throw new Error(`access setup did not yield allow: ${grant.error || JSON.stringify(grant.data)}`);
    }
    const releaseWarmup = await Promise.all(Array.from({ length: 5 }, () => (
      openAuthorizedFile(tokens[ACCESS_IDENTITY], accessRecordId)
    )));
    if (releaseWarmup.some((sample) => !sample.ok)) {
      throw new Error(`release warm-up failed: ${JSON.stringify(releaseWarmup.filter((s) => !s.ok))}`);
    }
    log(`Authorized synthetic record for release measurements: ${accessRecordId}`);
  }
  log('');

  const rounds = [];
  const samples = [];
  const partialRawPath = path.join(runDir, 'raw-samples.partial.jsonl');
  const partialRoundsPath = path.join(runDir, 'rounds.partial.jsonl');
  for (const operation of OPERATIONS) {
    log(`${operation.toUpperCase()} MEASUREMENTS`);
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      for (const level of LEVELS) {
        const result = await releaseBatch(operation, repetition, level, tokens, accessRecordId);
        rounds.push(result.round);
        samples.push(...result.samples);
        fs.appendFileSync(partialRoundsPath, `${JSON.stringify(result.round)}\n`);
        fs.appendFileSync(partialRawPath,
          `${result.samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
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
    'operation', 'repetition', 'concurrentSessions', 'attempted', 'successful', 'failed',
    'minMs', 'p50Ms', 'meanMs', 'p95Ms', 'maxMs', 'batchWallClockMs', 'throughputRps',
  ];
  const summaryColumns = [
    'operation', 'concurrentSessions', 'batches', 'attempted', 'successful', 'failed',
    'minMs', 'p50Ms', 'meanMs', 'p95Ms', 'maxMs', 'batchP50MeanMs', 'batchP50SdMs',
  ];
  const rawPath = path.join(runDir, 'raw-samples.jsonl');
  fs.writeFileSync(rawPath, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
  fs.writeFileSync(path.join(runDir, 'rounds.csv'), csv(rounds, roundColumns));
  fs.writeFileSync(path.join(runDir, 'summary.csv'), csv(summary, summaryColumns));
  fs.writeFileSync(path.join(runDir, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);

  const report = {
    experiment: 'live interactive latency on Hyperledger Fabric',
    runId,
    generatedAtUtc: new Date().toISOString(),
    config,
    environment,
    accessSetup: grant ? {
      recordId: accessRecordId,
      decisionId: grant.data.decisionId,
      decision: grant.data.decision,
      setupLatencyMs: rounded(grant.elapsedMs),
      excludedFromMeasurements: true,
    } : null,
    rounds,
    summary,
    totals: {
      attempted: samples.length,
      successful: samples.filter((sample) => sample.ok).length,
      failed: samples.filter((sample) => !sample.ok).length,
    },
    interpretationLimits: [
      'The concurrency levels are simultaneous client sessions, not distinct enrolled officers.',
      'All services ran on one host, so results do not estimate wide-area or multi-host performance.',
      'The release path is end-to-end authorization plus vault retrieval and hash verification; it is not isolated chaincode compute time.',
      'Three batches per point expose limited run-to-run variability but do not establish a production capacity threshold.',
    ],
  };
  const reportPath = path.join(runDir, 'run-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const artifactFiles = [
    'config.json', 'environment.json', 'experiment.log', 'raw-samples.jsonl',
    'raw-samples.partial.jsonl', 'rounds.csv', 'rounds.partial.jsonl',
    'summary.csv', 'run-report.json',
  ];
  log(`Completed: ${report.totals.successful}/${report.totals.attempted} successful`);
  log(`RUN_DIR=${runDir}`);

  const manifest = {
    runId,
    generatedAtUtc: new Date().toISOString(),
    artifacts: Object.fromEntries(artifactFiles.map((file) => [file, {
      sha256: sha256(path.join(runDir, file)),
      bytes: fs.statSync(path.join(runDir, file)).size,
    }])),
  };
  fs.writeFileSync(path.join(runDir, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log(`ABORTED: received ${signal}; partial JSONL artifacts were retained`);
    process.exit(130);
  });
}

main().catch((error) => {
  log(`FAILED: ${error.stack || error}`);
  process.exitCode = 1;
});
