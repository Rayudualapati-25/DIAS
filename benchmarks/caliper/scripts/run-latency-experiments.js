'use strict';

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CALIPER_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(CALIPER_DIR, '..', '..');
const RUNS_DIR = path.join(PROJECT_DIR, 'experiments', 'runs');
const RUNNER = path.join(CALIPER_DIR, 'scripts', 'run-benchmark.js');
const PLOTTER = path.join(PROJECT_DIR, 'results', 'plots', 'caliper_latency_axes.py');
const LOCK_PATH = path.join(RUNS_DIR, '.caliper-latency-suite.lock');

const RUN_SPECS = [
  { key: 'clients1', config: 'configs/latency-clients-1.yaml', label: 'latency-clients-1' },
  { key: 'clients2', config: 'configs/latency-clients-2.yaml', label: 'latency-clients-2' },
  { key: 'clients4', config: 'configs/latency-clients-4.yaml', label: 'latency-clients-4' },
  { key: 'clients8', config: 'configs/latency-clients-8.yaml', label: 'latency-clients-8' },
  { key: 'writeTps', config: 'configs/latency-write-tps.yaml', label: 'latency-write-tps' },
  { key: 'queryCount', config: 'configs/latency-query-count.yaml', label: 'latency-query-count' },
  { key: 'policyPath', config: 'configs/latency-policy-path.yaml', label: 'latency-policy-path' },
  { key: 'stability', config: 'configs/latency-stability-short.yaml', label: 'latency-stability' },
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadResumeRuns(resumeManifestArgument) {
  if (!resumeManifestArgument) return { source: null, runs: [] };
  const sourcePath = path.resolve(PROJECT_DIR, resumeManifestArgument);
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (source.status !== 'failed') {
    throw new Error(`resume source must be a failed suite: ${sourcePath}`);
  }
  if (!Array.isArray(source.runs)) {
    throw new Error(`resume source has no runs array: ${sourcePath}`);
  }
  const runs = source.runs.map((run, index) => {
    const spec = RUN_SPECS[index];
    if (!spec || run.key !== spec.key || run.config !== spec.config) {
      throw new Error('resume runs must be an exact completed prefix of the latency suite');
    }
    const runDirectory = path.resolve(PROJECT_DIR, run.runDirectory);
    const manifestPath = path.join(runDirectory, 'run-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.status !== 'completed' || manifest.runId !== run.runId) {
      throw new Error(`resume run is not completed or has the wrong ID: ${manifestPath}`);
    }
    const currentConfig = path.join(CALIPER_DIR, spec.config);
    if (sha256File(currentConfig) !== manifest.benchmarkConfigSha256) {
      throw new Error(`resume run config no longer matches ${spec.config}`);
    }
    return { ...run, reusedFromSuiteId: source.suiteId };
  });
  return { source: { path: sourcePath, suiteId: source.suiteId }, runs };
}

function assertNoOtherCaliperRun() {
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const active = processes.split(/\r?\n/).filter((line) => (
    /caliper launch manager/.test(line) || /scripts\/run-benchmark\.js/.test(line)
  ));
  if (active.length > 0) {
    throw new Error(
      `another Caliper benchmark is already active; refusing overlapping measurements:\n${active.join('\n')}`
    );
  }
}

function acquireLock() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  try {
    const descriptor = fs.openSync(LOCK_PATH, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, startedAtUtc: new Date().toISOString() })}\n`
    );
    fs.closeSync(descriptor);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`latency suite lock already exists: ${LOCK_PATH}`);
    }
    throw error;
  }
}

function runBenchmark(spec) {
  process.stdout.write(`\n=== ${spec.label}: ${spec.config} ===\n`);
  const result = spawnSync(
    process.execPath,
    [RUNNER, spec.config, spec.label],
    {
      cwd: CALIPER_DIR,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = combined.match(/Run artifacts: (.+)/);
  const runDirectory = match ? match[1].trim() : null;
  if (result.status !== 0 || !runDirectory) {
    throw new Error(
      `${spec.label} failed${runDirectory ? `; retained at ${runDirectory}` : ''}`
    );
  }
  const manifestPath = path.join(runDirectory, 'run-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 'completed') {
    throw new Error(`${spec.label} did not produce a completed run manifest`);
  }
  return {
    key: spec.key,
    label: spec.label,
    config: spec.config,
    runId: manifest.runId,
    runDirectory: path.relative(PROJECT_DIR, runDirectory),
  };
}

function point(run, roundLabel, xValue, xLabel = String(xValue)) {
  return {
    runId: run.runId,
    runDirectory: run.runDirectory,
    roundLabel,
    xValue,
    xLabel,
  };
}

function axes(runByKey) {
  const clients = [1, 2, 4, 8];
  const tps = [1, 2, 5, 10, 20];
  const policyPoints = [
    ['policy-rule1-credential-revoked', 1, 'Credential revoked'],
    ['policy-rule3-rbac', 3, 'RBAC deny'],
    ['policy-rule6-cross-jurisdiction', 6, 'Cross-jurisdiction'],
    ['policy-rule7-not-assigned', 7, 'Not assigned'],
    ['policy-full-allow', 8, 'Full allow'],
  ];
  return [
    {
      id: 'concurrent_clients_vs_lookup_latency',
      title: 'Record Lookup Latency vs Concurrent Caliper Clients',
      xAxis: 'Concurrent Caliper clients (one request/s each)',
      points: clients.map((count) => point(
        runByKey[`clients${count}`], `clients-${count}-read`, count
      )),
    },
    {
      id: 'offered_tps_vs_write_latency',
      title: 'Access-Write Latency vs Offered Transaction Rate',
      xAxis: 'Offered transaction rate (TPS)',
      points: tps.map((rate) => point(runByKey.writeTps, `write-tps-${rate}`, rate)),
    },
    {
      id: 'query_result_count_vs_latency',
      title: 'Record Query Latency vs Results Returned',
      xAxis: 'Records returned by verified query',
      points: [1, 2, 3].map((count) => point(
        runByKey.queryCount, `query-count-${count}`, count
      )),
    },
    {
      id: 'policy_path_vs_latency',
      title: 'Access-Write Latency by Verified Policy Path',
      xAxis: 'Policy path',
      categorical: true,
      points: policyPoints.map(([label, order, display]) => point(
        runByKey.policyPath, label, order, display
      )),
    },
    {
      id: 'elapsed_time_vs_latency',
      title: 'Access-Write Latency During the Stability Pilot',
      xAxis: 'Elapsed measurement time (minutes; bin midpoint)',
      points: Array.from({ length: 10 }, (_, index) => {
        const bin = index + 1;
        const midpointMinutes = (index * 30 + 15) / 60;
        return point(
          runByKey.stability,
          `stability-bin-${String(bin).padStart(2, '0')}`,
          midpointMinutes,
          midpointMinutes.toFixed(2)
        );
      }),
    },
  ];
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--resume-suite')) {
    throw new Error('usage: run-latency-experiments.js [--resume-suite <suite-manifest.json>]');
  }
  const resumed = loadResumeRuns(args.length === 2 ? args[1] : null);
  assertNoOtherCaliperRun();
  let lockAcquired = false;
  let suite = null;
  let suiteManifestPath = null;

  try {
    acquireLock();
    lockAcquired = true;
    const suiteId = `${timestamp()}_caliper_latency_pilot_suite`;
    const suiteDirectory = path.join(RUNS_DIR, suiteId);
    suiteManifestPath = path.join(suiteDirectory, 'suite-manifest.json');
    fs.mkdirSync(suiteDirectory, { recursive: false });
    suite = {
      schemaVersion: 1,
      suiteId,
      status: 'running',
      startedAtUtc: new Date().toISOString(),
      interpretation: 'Single live-network pilot; not repeated paper evidence.',
      controls: {
        execution: 'strictly sequential; overlap guard and exclusive suite lock',
        ledgerResetBetweenPoints: false,
        warmupsExcludedFromAxes: true,
        resumedFromSuite: resumed.source,
      },
      runs: resumed.runs,
      axes: [],
      failureReason: null,
    };
    writeJson(suiteManifestPath, suite);

    for (const spec of RUN_SPECS) {
      if (suite.runs.some((run) => run.key === spec.key)) continue;
      const completed = runBenchmark(spec);
      suite.runs.push(completed);
      writeJson(suiteManifestPath, suite);
    }
    const runByKey = Object.fromEntries(suite.runs.map((run) => [run.key, run]));
    suite.axes = axes(runByKey);
    suite.status = 'completed';
    suite.finishedAtUtc = new Date().toISOString();
    writeJson(suiteManifestPath, suite);

    if (!fs.existsSync(PLOTTER)) {
      throw new Error(`latency plotter is missing: ${PLOTTER}`);
    }
    execFileSync(
      'python3', [PLOTTER, '--suite-manifest', suiteManifestPath],
      { cwd: PROJECT_DIR, stdio: 'inherit' }
    );
    process.stdout.write(`Latency suite manifest: ${suiteManifestPath}\n`);
  } catch (error) {
    if (suite && suiteManifestPath) {
      suite.status = 'failed';
      suite.finishedAtUtc = new Date().toISOString();
      suite.failureReason = error.message;
      writeJson(suiteManifestPath, suite);
    }
    throw error;
  } finally {
    if (lockAcquired && fs.existsSync(LOCK_PATH)) fs.unlinkSync(LOCK_PATH);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { RUN_SPECS, axes, assertNoOtherCaliperRun, loadResumeRuns, point };
