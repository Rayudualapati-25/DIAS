'use strict';

/**
 * Does access-decision latency degrade as the ledger grows?
 *
 * Fabric reads world state through several different mechanisms, and they do
 * NOT scale alike. This experiment separates them instead of reporting one
 * blended "query latency" number:
 *
 *   1. point read        getState by key            expected: flat
 *   2. rich query        getQueryResult (Mango)     expected: linear, unindexed
 *   3. scoped range scan getStateByPartialCompositeKey([recordId])
 *   4. full range scan   getStateByPartialCompositeKey([])
 *   5. access decision   point reads + ordered commit
 *
 * The access-decision path reads the user profile, case, record and active
 * policy by key, so the prediction is that the paper's core operation stays
 * flat while the unindexed rich query degrades. Measuring them together would
 * hide exactly the effect worth reporting.
 *
 * Isolation of the independent variable:
 *   - Filler records are written to owningStation 'PS-BULK'. The probe query
 *     asks for 'PS-Central', which only the three seeded demo records use, so
 *     the RESULT SET STAYS CONSTANT (3 documents) while the COLLECTION grows
 *     from ~1k to 100k. What changes is scan cost, not serialisation cost.
 *   - Reads are measured serially. A query never reaches the orderer, so there
 *     is no block wait to amortise and concurrency would only add queueing noise.
 *   - The decision path is a write, so it is measured at fixed concurrency 20 —
 *     inside the flat region established by the earlier concurrency sweep, and
 *     above the point where BatchTimeout dominates.
 *
 * Prerequisites: make all; make backend
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const COUCH = process.env.COUCH_BASE || 'http://admin:adminpw@localhost:5984';
const COUCH_DB = process.env.COUCH_DB || 'crimechannel_crimerecords';
const OUT_DIR = __dirname;

// Cumulative record counts at which the ledger is measured. Overridable so the
// harness can be smoke-tested cheaply before a multi-hour run.
const GROWTH_POINTS = (process.env.GROWTH_POINTS || '1000,5000,10000,25000,50000,100000')
  .split(',').map((v) => Number(v.trim()));

const SEED_CONCURRENCY = 60;
const DECISION_CONCURRENCY = 20;
const REPETITIONS = 3;

const SAMPLES = Object.freeze({
  pointRead: 30,
  richQuery: 15,
  auditTrail: 15,
  accessLog: 10,
  decision: 40,
});

const FILING_IDENTITIES = Object.freeze([
  'sho.reddy', 'insp.sharma', 'const.verma', 'io.krishnan', 'insp.sharma',
]);

const CASE_ID = 'CASE-2026-001';
const JURISDICTION = 'district-north';
const BULK_STATION = 'PS-BULK';     // filler records
const PROBE_STATION = 'PS-Central'; // the 3 demo records only
const PROBE_RECORD = 'REC-FIR-001';

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
      ok: json.success === true,
      data: json.data,
      error: json.error,
      elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    };
  } catch (err) {
    return {
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

/**
 * World-state size straight from the peer's CouchDB, not inferred.
 *
 * Credentials go in an Authorization header, not the URL: WHATWG fetch refuses
 * to construct a Request from a URL that embeds them.
 */
async function couchStats() {
  try {
    const url = new URL(COUCH);
    const auth = Buffer
      .from(`${url.username || 'admin'}:${url.password || 'adminpw'}`)
      .toString('base64');
    const response = await fetch(`${url.origin}/${COUCH_DB}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) return { available: false, status: response.status };
    const body = await response.json();
    return {
      available: true,
      docCount: body.doc_count,
      dataSizeBytes: body.sizes ? body.sizes.active : null,
      diskSizeBytes: body.sizes ? body.sizes.file : null,
    };
  } catch (err) {
    return { available: false, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------- statistics

function percentile(sortedAscending, fraction) {
  if (sortedAscending.length === 0) return null;
  const rank = Math.ceil(fraction * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank - 1, 0), sortedAscending.length - 1)];
}

const round = (v) => (v === null || v === undefined ? null : Number(v.toFixed(2)));

function summarise(samples) {
  const good = samples.filter((s) => s.ok);
  const latencies = [...good.map((s) => s.elapsedMs)].sort((a, b) => a - b);
  const mean = latencies.length
    ? latencies.reduce((sum, v) => sum + v, 0) / latencies.length : null;
  return {
    samples: samples.length,
    successful: good.length,
    failed: samples.length - good.length,
    minMs: round(latencies[0] ?? null),
    p50Ms: round(percentile(latencies, 0.5)),
    meanMs: round(mean),
    p95Ms: round(percentile(latencies, 0.95)),
    maxMs: round(latencies[latencies.length - 1] ?? null),
  };
}

// ---------------------------------------------------------------- seeding

function fillerBody(recordId) {
  return {
    recordId,
    payload: { summary: 'synthetic filler record for ledger-growth scaling' },
    meta: {
      caseId: CASE_ID,
      recordType: 'case-diary',
      sensitivityLevel: 'low',
      owningStation: BULK_STATION,
      jurisdiction: JURISDICTION,
    },
  };
}

/**
 * How many filler records already exist, so an interrupted run can resume
 * instead of re-seeding from zero. Filler ids are densely numbered, so a
 * binary search finds the boundary in ~17 point reads rather than a scan.
 */
async function countExistingFiller(tokens, upperBound) {
  const exists = async (index) => {
    const result = await api('GET', `/records/BULK-${String(index).padStart(6, '0')}`,
      { token: tokens['aud.qureshi'] });
    return result.ok;
  };
  if (!await exists(0)) return 0;

  let low = 0;             // known to exist
  let high = upperBound;   // assumed not to exist
  if (await exists(high - 1)) return high;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await exists(mid)) low = mid; else high = mid;
  }
  return low + 1;
}

/** Grow the ledger to `target` filler records, in bounded concurrent waves. */
async function seedTo(tokens, alreadySeeded, target) {
  const toWrite = target - alreadySeeded;
  if (toWrite <= 0) return alreadySeeded;

  process.stdout.write(`  seeding ${toWrite} records -> ${target} ... `);
  const started = Date.now();
  let written = alreadySeeded;
  let failures = 0;

  while (written < target) {
    const waveSize = Math.min(SEED_CONCURRENCY, target - written);
    const wave = Array.from({ length: waveSize }, (unused, i) => {
      const index = written + i;
      const username = FILING_IDENTITIES[index % FILING_IDENTITIES.length];
      return api('POST', '/records', {
        token: tokens[username],
        body: fillerBody(`BULK-${String(index).padStart(6, '0')}`),
      });
    });
    const results = await Promise.all(wave);
    failures += results.filter((r) => !r.ok).length;
    written += waveSize;
  }

  const seconds = (Date.now() - started) / 1000;
  process.stdout.write(
    `done in ${seconds.toFixed(0)}s (${(toWrite / seconds).toFixed(0)} rec/s`
    + `${failures ? `, ${failures} FAILED` : ''})\n`
  );
  return written;
}

// ---------------------------------------------------------------- operations

async function repeat(count, thunk) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(await thunk(i));
  return out;
}

function operations(tokens) {
  return {
    // 1. getState by key — the control. Should not care how big the ledger is.
    pointRead: () => repeat(SAMPLES.pointRead, () =>
      api('GET', `/records/${PROBE_RECORD}`, { token: tokens['aud.qureshi'] })),

    // 2. CouchDB rich query, no index defined. Constant 3-document result.
    richQuery: () => repeat(SAMPLES.richQuery, () =>
      api('GET', `/records?owningStation=${PROBE_STATION}`,
        { token: tokens['aud.qureshi'] })),

    // 3. Composite-key scan scoped to one record, plus its key history.
    auditTrail: () => repeat(SAMPLES.auditTrail, () =>
      api('GET', `/audit/trail/${PROBE_RECORD}`, { token: tokens['aud.qureshi'] })),

    // 4. Composite-key scan over every access event on the channel.
    accessLog: () => repeat(SAMPLES.accessLog, () =>
      api('GET', '/audit/access-log', { token: tokens['aud.qureshi'] })),

    // 5. The paper's core operation: point reads, policy evaluation, ordered
    //    commit of the decision and its explanation. Fixed concurrency.
    decision: async () => {
      const out = [];
      let issued = 0;
      while (issued < SAMPLES.decision) {
        const waveSize = Math.min(DECISION_CONCURRENCY, SAMPLES.decision - issued);
        const wave = Array.from({ length: waveSize }, () =>
          api('POST', '/access/request', {
            token: tokens['io.krishnan'],
            body: { recordId: PROBE_RECORD, action: 'view', purpose: 'investigation' },
          }));
        out.push(...await Promise.all(wave));
        issued += waveSize;
      }
      return out;
    },
  };
}

async function measureAt(tokens, recordCount) {
  const ops = operations(tokens);
  const names = Object.keys(ops);
  const perRepetition = [];

  for (let rep = 0; rep < REPETITIONS; rep += 1) {
    const round = {};
    for (const name of names) round[name] = summarise(await ops[name]());
    perRepetition.push(round);
  }

  // Average each metric across repetitions.
  //
  // An operation that failed every sample has no latency, which is NOT the same
  // as a latency of zero. It must stay null so a figure cannot silently plot a
  // timeout as an instant response.
  const merged = {};
  for (const name of names) {
    const p50s = perRepetition.map((r) => r[name].p50Ms).filter((v) => v !== null);
    const p95s = perRepetition.map((r) => r[name].p95Ms).filter((v) => v !== null);
    const attempted = perRepetition.reduce((sum, r) => sum + r[name].samples, 0);
    const failed = perRepetition.reduce((sum, r) => sum + r[name].failed, 0);
    const mean = (values) => (values.length
      ? round(values.reduce((a, b) => a + b, 0) / values.length) : null);
    merged[name] = {
      p50Ms: mean(p50s),
      p95Ms: mean(p95s),
      attempted,
      failed,
      failureRate: attempted ? round((failed / attempted) * 100) : null,
      allSamplesFailed: failed === attempted && attempted > 0,
      repetitions: perRepetition.map((r) => r[name].p50Ms),
    };
  }

  const couch = await couchStats();
  const show = (m) => (m.allSamplesFailed
    ? 'TIMEOUT' : `${m.p50Ms}${m.failed ? `(${m.failed}f)` : ''}`);
  console.log(
    `  ledger ${String(recordCount).padStart(6)} records | `
    + `point ${show(merged.pointRead).padStart(7)} | `
    + `rich ${show(merged.richQuery).padStart(8)} | `
    + `trail ${show(merged.auditTrail).padStart(7)} | `
    + `log ${show(merged.accessLog).padStart(8)} | `
    + `decision ${show(merged.decision).padStart(7)} ms`
  );

  return { recordCount, couch, operations: merged, perRepetition };
}

// ---------------------------------------------------------------- main

async function main() {
  const health = await api('GET', '/health');
  if (!health.ok) {
    console.error(`backend is not reachable at ${BASE}\nstart it with: make backend`);
    process.exit(1);
  }

  const identities = [...new Set([...FILING_IDENTITIES, 'aud.qureshi', 'io.krishnan'])];
  const entries = await Promise.all(identities.map(async (u) => [u, await login(u)]));
  const tokens = Object.fromEntries(entries);
  console.log(`${identities.length} identities ready\n`);

  const outPath = path.join(OUT_DIR, 'ledger_growth.json');
  const report = {
    experiment: 'access-decision latency as the ledger grows',
    generatedAtUtc: new Date().toISOString(),
    environment: {
      channel: 'crimechannel',
      chaincode: 'crimerecords',
      organizations: 5,
      stateDatabase: 'CouchDB',
      couchDbIndexes: 'none defined (no META-INF/statedb/couchdb/indexes)',
      batchTimeout: '2s',
      maxMessageCount: 10,
      host: 'single machine, Colima 10 vCPU / 24 GiB',
    },
    method: {
      readsMeasured: 'serially at concurrency 1; queries never reach the orderer',
      decisionMeasured: `concurrency ${DECISION_CONCURRENCY}`,
      repetitions: REPETITIONS,
      resultSetControl:
        `filler records use owningStation ${BULK_STATION}; the probe query asks `
        + `for ${PROBE_STATION}, matched only by the 3 seeded demo records, so the `
        + 'result set stays constant while the collection grows',
      operationClasses: {
        pointRead: 'getState by key',
        richQuery: 'getQueryResult, CouchDB Mango selector, no index',
        auditTrail: 'getStateByPartialCompositeKey([recordId]) + getHistoryForKey',
        accessLog: 'getStateByPartialCompositeKey([]) over all access events',
        decision: 'point reads + policy evaluation + ordered commit',
      },
    },
    points: [],
  };

  // Carry forward checkpoints from an interrupted attempt so a resumed run
  // still writes one complete dataset rather than a fragment.
  if (fs.existsSync(outPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      report.points = previous.points || [];
      if (report.points.length) {
        console.log(`carrying forward ${report.points.length} checkpoint(s) from a previous attempt`);
      }
    } catch (err) {
      console.log(`could not reuse previous results (${err.message}); starting fresh`);
    }
  }
  const measured = new Set(report.points.map((p) => p.recordCount));

  let seeded = await countExistingFiller(tokens, Math.max(...GROWTH_POINTS));
  if (seeded > 0) console.log(`resuming: ${seeded} filler records already on the ledger\n`);

  for (const target of GROWTH_POINTS) {
    if (measured.has(target)) {
      console.log(`  skipping ${target} (already measured)`);
      continue;
    }
    // A previous attempt already grew past this checkpoint; its measurement
    // cannot be repeated at the right ledger size, so skip rather than mislabel.
    if (seeded > target) {
      console.log(`  skipping ${target} (ledger already at ${seeded})`);
      continue;
    }
    seeded = await seedTo(tokens, seeded, target);
    report.points.push(await measureAt(tokens, seeded));
    // Written after every point so a long run never loses earlier data.
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  const csvPath = path.join(OUT_DIR, 'ledger_growth.csv');
  const columns = ['pointRead', 'richQuery', 'auditTrail', 'accessLog', 'decision'];
  const header = ['recordCount', 'couchDocCount', 'couchDataSizeBytes',
    ...columns.flatMap((c) => [`${c}_p50Ms`, `${c}_p95Ms`])].join(',');
  const rows = report.points.map((p) => [
    p.recordCount,
    p.couch.docCount ?? '',
    p.couch.dataSizeBytes ?? '',
    ...columns.flatMap((c) => [p.operations[c].p50Ms, p.operations[c].p95Ms]),
  ].join(','));
  fs.writeFileSync(csvPath, `${header}\n${rows.join('\n')}\n`);

  console.log(`\nWrote:\n  ${outPath}\n  ${csvPath}`);
}

main().catch((err) => {
  console.error(`ledger-growth experiment failed: ${err.message}`);
  process.exit(1);
});
