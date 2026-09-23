'use strict';

/**
 * Concurrent record-filing latency experiment against the live Fabric network.
 *
 * Question: when N officers file a record at the same instant, what latency
 * does each of them observe?
 *
 * Every measured request is a WRITE (POST /records -> RecordContract
 * CreateCaseRecord), so each one travels the full path: REST validation, vault
 * write, Fabric Gateway, endorsement by the police peer, ordering, block
 * formation, and commit observation. Latency is therefore client-observed
 * end-to-end time, not policy-computation time.
 *
 * Concurrency is genuine: all N requests for a level are released together and
 * awaited as one batch.
 *
 * No two requests write the same ledger key — each gets a unique recordId, and
 * CreateCaseRecord only reads the shared case key. That avoids MVCC read
 * conflicts, so the numbers measure latency rather than write contention.
 *
 * Prerequisites: make all; make backend
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OUT_DIR = __dirname;

// Repeat the whole sweep to expose run-to-run variance. Outputs are suffixed so
// repetitions never overwrite one another.
const RUN_LABEL = process.env.RUN_LABEL || 'run1';

// Levels the experiment sweeps. The single-client level is the control: it
// exposes the orderer's BatchTimeout, which dominates when no block ever fills.
const LEVELS = [1, 10, 20, 40, 50, 75, 100];

// Police identities permitted to file a record. insp.rathore is deliberately
// excluded: its certificate carries credentialStatus=revoked, which would mix
// policy denials into a latency measurement.
const FILING_IDENTITIES = Object.freeze([
  'sho.reddy', 'insp.sharma', 'const.verma', 'io.krishnan', 'insp.singh',
]);

const CASE_ID = 'CASE-2026-001';
const JURISDICTION = 'district-north';
const OWNING_STATION = 'PS-Central';

const WARMUP_REQUESTS = 5;
const COOLDOWN_MS = 4000;

// ---------------------------------------------------------------- transport

async function api(method, urlPath, { token, body } = {}) {
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    return {
      status: response.status,
      ok: json.success === true,
      data: json.data,
      error: json.error,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      data: null,
      error: String(err.message || err),
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  }
}

async function login(username) {
  const result = await api('POST', '/auth/login', { body: { username } });
  if (!result.ok) throw new Error(`login ${username}: ${result.error}`);
  return result.data.token;
}

// ---------------------------------------------------------------- statistics

/** Nearest-rank percentile over an ascending copy; never mutates the input. */
function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1);
  return sortedAscending[index];
}

function round(value) {
  return value === null ? null : Number(value.toFixed(2));
}

function summarise(level, samples, wallClockMs) {
  const successes = samples.filter((s) => s.ok);
  const latencies = [...successes.map((s) => s.elapsedMs)].sort((a, b) => a - b);
  const mean = latencies.length
    ? latencies.reduce((sum, v) => sum + v, 0) / latencies.length
    : null;

  return {
    concurrentUsers: level,
    requests: samples.length,
    successful: successes.length,
    failed: samples.length - successes.length,
    minMs: round(latencies[0] ?? null),
    p50Ms: round(percentile(latencies, 0.5)),
    meanMs: round(mean),
    p95Ms: round(percentile(latencies, 0.95)),
    p99Ms: round(percentile(latencies, 0.99)),
    maxMs: round(latencies[latencies.length - 1] ?? null),
    batchWallClockMs: round(wallClockMs),
    throughputTps: round(successes.length / (wallClockMs / 1000)),
  };
}

// ---------------------------------------------------------------- experiment

function buildRequest(tokens, level, index, runStamp) {
  const username = FILING_IDENTITIES[index % FILING_IDENTITIES.length];
  return {
    username,
    token: tokens[username],
    recordId: `LOAD-${runStamp}-N${level}-${String(index).padStart(3, '0')}`,
  };
}

async function fileRecord(spec) {
  const result = await api('POST', '/records', {
    token: spec.token,
    body: {
      recordId: spec.recordId,
      payload: {
        summary: 'synthetic load-test record, no real case content',
        generatedBy: 'loadtest.js',
      },
      meta: {
        caseId: CASE_ID,
        recordType: 'fir',
        sensitivityLevel: 'low',
        owningStation: OWNING_STATION,
        jurisdiction: JURISDICTION,
      },
    },
  });
  return {
    recordId: spec.recordId,
    username: spec.username,
    ok: result.ok,
    status: result.status,
    error: result.ok ? null : result.error,
    elapsedMs: result.elapsedMs,
  };
}

async function warmUp(tokens, runStamp) {
  process.stdout.write(`warm-up (${WARMUP_REQUESTS} discarded requests) ... `);
  for (let i = 0; i < WARMUP_REQUESTS; i += 1) {
    await fileRecord(buildRequest(tokens, 0, i, `${runStamp}-warm`));
  }
  process.stdout.write('done\n');
}

async function runLevel(tokens, level, runStamp) {
  const specs = Array.from({ length: level }, (unused, index) =>
    buildRequest(tokens, level, index, runStamp));

  const started = process.hrtime.bigint();
  const samples = await Promise.all(specs.map(fileRecord));
  const wallClockMs = Number(process.hrtime.bigint() - started) / 1e6;

  const summary = summarise(level, samples, wallClockMs);
  const failed = summary.failed
    ? `  FAILED ${summary.failed}`
    : '';
  console.log(
    `N=${String(level).padStart(3)}  `
    + `p50 ${String(summary.p50Ms).padStart(8)} ms  `
    + `p95 ${String(summary.p95Ms).padStart(8)} ms  `
    + `max ${String(summary.maxMs).padStart(8)} ms  `
    + `${String(summary.throughputTps).padStart(6)} tps${failed}`
  );

  return { summary, samples };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------- reporting

function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((row) => columns.map((c) => row[c]).join(','));
  return [header, ...body].join('\n') + '\n';
}

async function main() {
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error(`backend is not reachable at ${BASE}`);
    console.error('start it with: make backend');
    process.exit(1);
  }

  console.log('Logging in the filing identities ...');
  const entries = await Promise.all(
    FILING_IDENTITIES.map(async (u) => [u, await login(u)]));
  const tokens = Object.fromEntries(entries);
  console.log(`${FILING_IDENTITIES.length} police identities ready\n`);

  const runStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await warmUp(tokens, runStamp);
  console.log('');

  const results = [];
  for (const level of LEVELS) {
    results.push(await runLevel(tokens, level, runStamp));
    await sleep(COOLDOWN_MS);
  }

  const summaries = results.map((r) => r.summary);
  const allSamples = results.flatMap((r, i) =>
    r.samples.map((s) => ({ concurrentUsers: LEVELS[i], ...s })));

  const report = {
    experiment: 'concurrent record filing on live Hyperledger Fabric',
    runLabel: RUN_LABEL,
    generatedAtUtc: new Date().toISOString(),
    environment: {
      channel: 'crimechannel',
      chaincode: 'crimerecords',
      organizations: 5,
      peersPerOrganization: 1,
      orderer: 'single-node Raft',
      batchTimeout: '2s',
      maxMessageCount: 10,
      stateDatabase: 'CouchDB',
      host: 'single machine, Colima 10 vCPU / 24 GiB',
      deployment: 'single-host local Docker; not a distributed benchmark',
    },
    method: {
      operation: 'POST /records (RecordContract CreateCaseRecord)',
      measured: 'client-observed end-to-end latency including REST, vault write, '
        + 'endorsement, ordering and commit',
      concurrency: 'all N requests released together and awaited as one batch',
      identityPool: FILING_IDENTITIES,
      identityNote: 'N concurrent client sessions drawn from a pool of '
        + `${FILING_IDENTITIES.length} enrolled police identities`,
      keyCollisions: 'none by construction; every request writes a unique recordId',
      warmupRequests: WARMUP_REQUESTS,
      cooldownMsBetweenLevels: COOLDOWN_MS,
    },
    levels: summaries,
    limitations: [
      'Single host; one peer per organisation; single-node Raft ordering.',
      'Latency is client-observed and includes the orderer batch wait.',
      'Synthetic records only; no real case content.',
      'Concurrency is simulated from a pool of 5 identities, not 100 distinct officers.',
    ],
  };

  const jsonPath = path.join(OUT_DIR, `latency_by_concurrency_${RUN_LABEL}.json`);
  const summaryCsvPath = path.join(OUT_DIR, `latency_by_concurrency_${RUN_LABEL}.csv`);
  const samplesCsvPath = path.join(OUT_DIR, `latency_raw_samples_${RUN_LABEL}.csv`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(summaryCsvPath, toCsv(summaries, [
    'concurrentUsers', 'requests', 'successful', 'failed', 'minMs', 'p50Ms',
    'meanMs', 'p95Ms', 'p99Ms', 'maxMs', 'batchWallClockMs', 'throughputTps',
  ]));
  fs.writeFileSync(samplesCsvPath, toCsv(allSamples, [
    'concurrentUsers', 'recordId', 'username', 'ok', 'status', 'elapsedMs',
  ]));

  console.log(`\nWrote:\n  ${jsonPath}\n  ${summaryCsvPath}\n  ${samplesCsvPath}`);
}

main().catch((err) => {
  console.error(`load test failed: ${err.message}`);
  process.exit(1);
});
