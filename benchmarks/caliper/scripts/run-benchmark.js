'use strict';

const { execFileSync, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CaliperUtils } = require('@hyperledger/caliper-core');
const { checkInstallation } = require('./check-installation');
const { prepareNetwork } = require('./prepare-network');

const CALIPER_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR = path.resolve(CALIPER_DIR, '..', '..');
const TX_LATENCY_OBSERVER = 'monitors/latency-tx-observer.js';
const TX_LATENCY_MARKER = 'CALIPER_TX_LATENCY';

function safeLabel(value) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value || '')) {
    throw new Error('run label must contain only lowercase letters, digits, underscores, or hyphens');
  }
  return value;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function dockerHost() {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  const context = process.env.DOCKER_CONTEXT || execFileSync(
    'docker', ['context', 'show'], { encoding: 'utf8' }
  ).trim();
  return execFileSync(
    'docker', ['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'],
    { encoding: 'utf8' }
  ).trim();
}

function resourceMonitorModules(benchmark) {
  return (benchmark.monitors && benchmark.monitors.resource
    ? benchmark.monitors.resource : [])
    .map((monitor) => monitor.module);
}

async function assertPrometheusReady(benchmark) {
  if (!resourceMonitorModules(benchmark).includes('prometheus')) return;
  const { checkMonitoring } = require('./check-monitoring');
  await checkMonitoring();
}

function copyWorkloads(benchmark, runDirectory) {
  const copied = [];
  const modules = new Set(
    benchmark.test.rounds.map((round) => round.workload.module)
  );
  for (const modulePath of modules) {
    const source = path.resolve(CALIPER_DIR, modulePath);
    const relative = path.relative(CALIPER_DIR, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`workload module must be inside the Caliper workspace: ${modulePath}`);
    }
    if (!fs.existsSync(source)) {
      throw new Error(`workload module is missing: ${source}`);
    }
    const destination = path.join(runDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push({ path: relative, sha256: sha256(source) });
  }
  return copied;
}

function copyMonitoringConfiguration(benchmark, runDirectory) {
  if (!resourceMonitorModules(benchmark).includes('prometheus')) return [];
  const files = ['monitoring/prometheus.yml', 'monitoring/compose.yaml'];
  const copied = [];
  for (const relative of files) {
    const source = path.join(CALIPER_DIR, relative);
    const destination = path.join(runDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push({ path: relative, sha256: sha256(source) });
  }
  return copied;
}

function copyTransactionObservers(benchmark, runDirectory) {
  const transactionMonitors = benchmark.monitors && benchmark.monitors.transaction
    ? benchmark.monitors.transaction : [];
  const copied = [];
  for (const monitor of transactionMonitors) {
    if (!monitor.module || monitor.module === 'logging' || monitor.module === 'prometheus'
      || monitor.module === 'prometheus-push') {
      continue;
    }
    const source = path.resolve(CALIPER_DIR, monitor.module);
    const relative = path.relative(CALIPER_DIR, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`transaction observer must be inside the Caliper workspace: ${monitor.module}`);
    }
    if (!fs.existsSync(source)) {
      throw new Error(`transaction observer is missing: ${source}`);
    }
    const destination = path.join(runDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    copied.push({ path: relative, sha256: sha256(source) });
  }
  return copied;
}

function configureTransactionEvidence(benchmark, options = {}) {
  if (!options.enabled) return benchmark;
  const configured = structuredClone(benchmark);
  configured.monitors = configured.monitors || {};
  const transactionMonitors = configured.monitors.transaction || [];
  if (!transactionMonitors.some((monitor) => (
    typeof monitor.module === 'string'
    && monitor.module.replace(/^\.\//, '') === TX_LATENCY_OBSERVER
  ))) {
    transactionMonitors.push({
      module: TX_LATENCY_OBSERVER,
      options: {},
    });
  }
  configured.monitors.transaction = transactionMonitors;
  return configured;
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function numericCell(value, column) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Caliper summary column '${column}' is not numeric: ${value}`);
  }
  return parsed;
}

function optionalNumericCell(value, column) {
  if (value === '-' || value === 'N/A') return null;
  return numericCell(value, column);
}

function parseSummaryTableHtml(html) {
  const section = html.match(/id=["']benchmarksummary["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!section) {
    throw new Error('Caliper report does not contain the benchmark summary section');
  }
  const table = section[1].match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) {
    throw new Error('Caliper report does not contain the benchmark summary table');
  }

  const tableRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1]);
  if (tableRows.length < 2) {
    throw new Error('Caliper benchmark summary table contains no result rows');
  }
  const headers = [...tableRows[0].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((match) => decodeHtml(match[1]));
  const required = [
    'Name', 'Succ', 'Fail', 'Send Rate (TPS)', 'Max Latency (s)',
    'Min Latency (s)', 'Avg Latency (s)', 'Throughput (TPS)',
  ];
  for (const column of required) {
    if (!headers.includes(column)) {
      throw new Error(`Caliper benchmark summary is missing column '${column}'`);
    }
  }

  return tableRows.slice(1).map((row, index) => {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => decodeHtml(match[1]));
    if (cells.length !== headers.length) {
      throw new Error(
        `Caliper benchmark summary row ${index + 1} has ${cells.length} cells; expected ${headers.length}`
      );
    }
    const byColumn = Object.fromEntries(headers.map((header, cellIndex) => [
      header, cells[cellIndex],
    ]));
    return {
      label: byColumn.Name,
      successfulTransactions: numericCell(byColumn.Succ, 'Succ'),
      failedTransactions: numericCell(byColumn.Fail, 'Fail'),
      observedSendRateTps: numericCell(byColumn['Send Rate (TPS)'], 'Send Rate (TPS)'),
      latencyMaxSeconds: optionalNumericCell(byColumn['Max Latency (s)'], 'Max Latency (s)'),
      latencyMinSeconds: optionalNumericCell(byColumn['Min Latency (s)'], 'Min Latency (s)'),
      latencyAverageSeconds: optionalNumericCell(byColumn['Avg Latency (s)'], 'Avg Latency (s)'),
      throughputTps: numericCell(byColumn['Throughput (TPS)'], 'Throughput (TPS)'),
    };
  });
}

function parseTransactionEvidenceLine(line) {
  const markerIndex = line.indexOf(TX_LATENCY_MARKER);
  if (markerIndex === -1) return null;
  const jsonStart = markerIndex + TX_LATENCY_MARKER.length;
  const rawJson = line.slice(jsonStart).trim();
  const event = JSON.parse(rawJson);
  const requiredIntegerFields = [
    'roundIndex', 'workerIndex', 'startEpochMs', 'endEpochMs', 'latencyMs',
  ];
  for (const field of requiredIntegerFields) {
    if (!Number.isFinite(event[field])) {
      throw new Error(`transaction evidence has invalid ${field}: ${rawJson}`);
    }
  }
  if (event.latencyMs < 0 || event.endEpochMs < event.startEpochMs) {
    throw new Error(`transaction evidence has invalid timing: ${rawJson}`);
  }
  if (typeof event.roundLabel !== 'string' || event.roundLabel.length === 0) {
    throw new Error(`transaction evidence has invalid roundLabel: ${rawJson}`);
  }
  if (typeof event.status !== 'string' || event.status.length === 0) {
    throw new Error(`transaction evidence has invalid status: ${rawJson}`);
  }
  return event;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const weight = rank - lowerIndex;
  return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
}

function summarizeTransactions(events, performanceSummary = null) {
  const byRound = new Map();
  for (const event of events) {
    if (!byRound.has(event.roundLabel)) {
      byRound.set(event.roundLabel, []);
    }
    byRound.get(event.roundLabel).push(event);
  }
  const rounds = [...byRound.entries()].map(([roundLabel, roundEvents]) => {
    const latencies = roundEvents.map((event) => event.latencyMs).sort((a, b) => a - b);
    const successfulTransactions = roundEvents.filter((event) => event.status === 'success').length;
    const failedTransactions = roundEvents.length - successfulTransactions;
    const totalLatency = latencies.reduce((total, latency) => total + latency, 0);
    return {
      roundLabel,
      roundIndex: roundEvents[0].roundIndex,
      count: roundEvents.length,
      successfulTransactions,
      failedTransactions,
      latencyMs: {
        min: latencies[0],
        mean: totalLatency / latencies.length,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.at(-1),
      },
    };
  }).sort((a, b) => a.roundIndex - b.roundIndex);

  if (performanceSummary) {
    const byLabel = new Map(rounds.map((round) => [round.roundLabel, round]));
    for (const summaryRow of performanceSummary) {
      const evidenceRound = byLabel.get(summaryRow.label);
      const expectedCount = summaryRow.successfulTransactions + summaryRow.failedTransactions;
      if (!evidenceRound) {
        throw new Error(`transaction evidence is missing round '${summaryRow.label}'`);
      }
      if (evidenceRound.count !== expectedCount) {
        throw new Error(
          `transaction evidence count mismatch for '${summaryRow.label}': ` +
          `${evidenceRound.count} observed, ${expectedCount} in Caliper summary`
        );
      }
      if (evidenceRound.successfulTransactions !== summaryRow.successfulTransactions
        || evidenceRound.failedTransactions !== summaryRow.failedTransactions) {
        throw new Error(`transaction evidence success/failure mismatch for '${summaryRow.label}'`);
      }
    }
  }

  return {
    transactions: events.length,
    rounds,
  };
}

function parseTransactionEvidence(logPath, options = {}) {
  const eventsByKey = new Map();
  for (const rawLine of fs.readFileSync(logPath, 'utf8').split(/\r?\n/)) {
    if (!rawLine.includes(TX_LATENCY_MARKER)) continue;
    const event = parseTransactionEvidenceLine(rawLine.replace(/\u001b\[[0-9;]*m/g, ''));
    const uniqueKey = [
      event.roundIndex,
      event.roundLabel,
      event.workerIndex,
      event.transactionId || '',
      event.status,
      event.startEpochMs,
      event.endEpochMs,
      event.latencyMs,
    ].join('|');
    if (!eventsByKey.has(uniqueKey)) eventsByKey.set(uniqueKey, event);
  }
  const events = [...eventsByKey.values()];
  if (options.required && events.length === 0) {
    throw new Error('transaction evidence observer was enabled but no transaction evidence was found');
  }
  return events;
}

function parseTransactionEvidenceFiles(directory) {
  const eventsByKey = new Map();
  const files = fs.readdirSync(directory)
    .filter((name) => /^latency-transactions-worker-\d+\.ndjson$/.test(name))
    .map((name) => path.join(directory, name))
    .sort();
  for (const file of files) {
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const event = parseTransactionEvidenceLine(`CALIPER_TX_LATENCY ${rawLine}`);
      const uniqueKey = [
        event.roundIndex,
        event.roundLabel,
        event.workerIndex,
        event.transactionId || '',
        event.status,
        event.startEpochMs,
        event.endEpochMs,
        event.latencyMs,
      ].join('|');
      if (!eventsByKey.has(uniqueKey)) eventsByKey.set(uniqueKey, event);
    }
  }
  return [...eventsByKey.values()];
}

function inspectOutcome(logPath, reportPath, caliperExitCode, options = {}) {
  const logText = fs.readFileSync(logPath, 'utf8')
    .replace(/\u001b\[[0-9;]*m/g, '');
  const summaries = [...logText.matchAll(
    /Total rounds: (\d+)\. Successful rounds: (\d+)\. Failed rounds: (\d+)\./g
  )];
  const summary = summaries.at(-1);
  const rounds = summary ? {
    total: Number(summary[1]),
    successful: Number(summary[2]),
    failed: Number(summary[3]),
  } : null;
  const reportCreated = fs.existsSync(reportPath);
  let performanceSummary = null;
  let summaryParseError = null;
  if (reportCreated) {
    try {
      performanceSummary = parseSummaryTableHtml(fs.readFileSync(reportPath, 'utf8'))
        .map((row) => ({
          ...row,
          phase: options.roundPhases && options.roundPhases[row.label]
            ? options.roundPhases[row.label] : 'measurement',
        }));
    } catch (error) {
      summaryParseError = error.message;
    }
  }
  const summaryComplete = rounds !== null
    && performanceSummary !== null
    && performanceSummary.length === rounds.total;
  const failedTransactions = performanceSummary === null ? null
    : performanceSummary.reduce((total, row) => total + row.failedTransactions, 0);
  const zeroFailuresRequired = Boolean(options.requireZeroTransactionFailures);
  const passed = caliperExitCode === 0
    && rounds !== null
    && rounds.total > 0
    && rounds.successful === rounds.total
    && rounds.failed === 0
    && reportCreated
    && summaryComplete
    && (!zeroFailuresRequired || failedTransactions === 0);

  let failureReason = null;
  if (caliperExitCode !== 0) {
    failureReason = `Caliper process exited with code ${caliperExitCode}`;
  } else if (rounds === null) {
    failureReason = 'Caliper did not write a round summary';
  } else if (rounds.failed > 0 || rounds.successful !== rounds.total) {
    failureReason = `${rounds.failed} of ${rounds.total} benchmark rounds failed`;
  } else if (!reportCreated) {
    failureReason = 'Caliper did not create the HTML report';
  } else if (summaryParseError) {
    failureReason = `Caliper report summary could not be parsed: ${summaryParseError}`;
  } else if (!summaryComplete) {
    failureReason = 'Caliper report does not contain one performance row for every round';
  } else if (zeroFailuresRequired && failedTransactions > 0) {
    failureReason = `Caliper reported ${failedTransactions} failed transaction(s)`;
  }

  let transactionEvidence = null;
  let transactionEvents = null;
  let transactionEvidenceError = null;
  if (options.transactionEvidenceRequired) {
    try {
      const fileEvents = options.transactionEvidenceDirectory
        ? parseTransactionEvidenceFiles(options.transactionEvidenceDirectory) : [];
      const events = fileEvents.length > 0 ? fileEvents : parseTransactionEvidence(logPath);
      if (events.length === 0) {
        throw new Error('transaction evidence observer was enabled but no transaction evidence was found');
      }
      transactionEvents = events;
      transactionEvidence = summarizeTransactions(events, performanceSummary);
    } catch (error) {
      transactionEvidenceError = error.message;
    }
    if (passed && transactionEvidenceError) {
      failureReason = transactionEvidenceError;
    }
  }

  return {
    passed: passed && (!options.transactionEvidenceRequired || !transactionEvidenceError),
    rounds,
    reportCreated,
    performanceSummary,
    transactionEvidence,
    transactionEvents,
    transactionEvidenceError,
    failedTransactions,
    failureReason,
  };
}

async function run() {
  const configArgument = process.argv[2];
  const label = safeLabel(process.argv[3] || 'manual');
  if (!configArgument) {
    throw new Error('usage: node scripts/run-benchmark.js <benchmark-config> <run-label>');
  }

  const benchmarkConfig = path.resolve(CALIPER_DIR, configArgument);
  if (!fs.existsSync(benchmarkConfig)) {
    throw new Error(`benchmark configuration is missing: ${benchmarkConfig}`);
  }
  const caliperBinary = path.join(CALIPER_DIR, 'node_modules', '.bin', 'caliper');
  if (!fs.existsSync(caliperBinary)) {
    throw new Error("Caliper is not installed. Run 'make caliper-install' first.");
  }
  checkInstallation();

  const inputBenchmark = CaliperUtils.parseYaml(benchmarkConfig);
  const isSmoke = path.basename(benchmarkConfig) === 'smoke.yaml';
  const transactionEvidenceEnabled = !isSmoke;
  const benchmark = configureTransactionEvidence(inputBenchmark, {
    enabled: transactionEvidenceEnabled,
  });
  await assertPrometheusReady(benchmark);
  const resolvedDockerHost = resourceMonitorModules(benchmark).includes('docker')
    ? dockerHost() : process.env.DOCKER_HOST || null;

  const prepared = prepareNetwork();
  const runId = `${timestamp()}_caliper_${label}`;
  const runDirectory = path.join(PROJECT_DIR, 'experiments', 'runs', runId);
  fs.mkdirSync(runDirectory, { recursive: false });

  const savedBenchmarkConfig = path.join(runDirectory, path.basename(benchmarkConfig));
  const executedBenchmarkConfig = path.join(runDirectory, 'caliper-executed-benchmark.yaml');
  const savedNetworkConfig = path.join(runDirectory, 'network-config.json');
  const savedEnvironment = path.join(runDirectory, 'environment.json');
  const reportPath = path.join(runDirectory, 'caliper-report.html');
  const summaryPath = path.join(runDirectory, 'caliper-summary.json');
  const transactionsPath = path.join(runDirectory, 'caliper-transactions.jsonl');
  const transactionSummaryPath = path.join(runDirectory, 'caliper-transaction-summary.json');
  const logPath = path.join(runDirectory, 'caliper.log');
  const manifestPath = path.join(runDirectory, 'run-manifest.json');
  fs.copyFileSync(benchmarkConfig, savedBenchmarkConfig);
  fs.writeFileSync(executedBenchmarkConfig, CaliperUtils.stringifyYaml(benchmark));
  fs.copyFileSync(prepared.configPath, savedNetworkConfig);
  fs.copyFileSync(prepared.environmentPath, savedEnvironment);
  const workloads = copyWorkloads(benchmark, runDirectory);
  const monitoringConfiguration = copyMonitoringConfiguration(benchmark, runDirectory);
  const transactionObservers = copyTransactionObservers(benchmark, runDirectory);

  const manifest = {
    runId,
    status: 'running',
    startedAtUtc: new Date().toISOString(),
    benchmarkConfig: path.basename(savedBenchmarkConfig),
    benchmarkConfigSha256: sha256(savedBenchmarkConfig),
    executedBenchmarkConfig: path.basename(executedBenchmarkConfig),
    executedBenchmarkConfigSha256: sha256(executedBenchmarkConfig),
    networkConfig: path.basename(savedNetworkConfig),
    networkConfigSha256: sha256(savedNetworkConfig),
    environment: path.basename(savedEnvironment),
    environmentSha256: sha256(savedEnvironment),
    report: path.basename(reportPath),
    log: path.basename(logPath),
    workloads,
    monitoringConfiguration,
    transactionEvidence: transactionEvidenceEnabled ? {
      observer: TX_LATENCY_OBSERVER,
      observerSource: transactionObservers,
      transactions: path.basename(transactionsPath),
      summary: path.basename(transactionSummaryPath),
      marker: TX_LATENCY_MARKER,
    } : null,
    controller: {
      caliper: require('@hyperledger/caliper-cli/package.json').version,
      fabricGateway: require('@hyperledger/fabric-gateway/package.json').version,
      grpc: require('@grpc/grpc-js/package.json').version,
      node: process.version,
      dockerHost: resolvedDockerHost,
      packageLockSha256: sha256(path.join(CALIPER_DIR, 'package-lock.json')),
    },
    interpretation: isSmoke
      ? 'Connectivity validation only; not paper-quality evidence.'
      : 'Characterization run. Paper use requires the declared repetitions, baseline, ablations, and retained aggregation artifacts.',
  };
  writeManifest(manifestPath, manifest);

  const args = [
    'launch', 'manager',
    '--caliper-workspace', CALIPER_DIR,
    '--caliper-benchconfig', executedBenchmarkConfig,
    '--caliper-networkconfig', prepared.configPath,
    '--caliper-report-path', reportPath,
    '--caliper-flow-only-test',
    '--caliper-progress-reporting-enabled', 'true',
    '--caliper-fabric-timeout-invokeorquery', '60',
  ];
  const log = fs.createWriteStream(logPath, { flags: 'wx' });
  const child = spawn(caliperBinary, args, {
    cwd: CALIPER_DIR,
    env: {
      ...process.env,
      ...(resolvedDockerHost ? { DOCKER_HOST: resolvedDockerHost } : {}),
      CALIPER_LATENCY_OBSERVER_DIR: runDirectory,
    },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    log.write(chunk);
  });

  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => log.end(resolve));

  const outcome = inspectOutcome(logPath, reportPath, exit.code, {
    requireZeroTransactionFailures: isSmoke,
    transactionEvidenceRequired: transactionEvidenceEnabled,
    transactionEvidenceDirectory: runDirectory,
    roundPhases: Object.fromEntries(benchmark.test.rounds.map((round) => [
      round.label,
      isSmoke ? 'connectivity' : round.label.includes('warmup') ? 'warmup' : 'measurement',
    ])),
  });
  if (outcome.performanceSummary) {
    fs.writeFileSync(
      summaryPath,
      `${JSON.stringify({ rounds: outcome.performanceSummary }, null, 2)}\n`
    );
  }
  if (outcome.transactionEvidence) {
    fs.writeFileSync(
      transactionsPath,
      outcome.transactionEvents
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n'
    );
    fs.writeFileSync(
      transactionSummaryPath,
      `${JSON.stringify(outcome.transactionEvidence, null, 2)}\n`
    );
  }
  manifest.finishedAtUtc = new Date().toISOString();
  manifest.caliperExitCode = exit.code;
  manifest.signal = exit.signal;
  manifest.rounds = outcome.rounds;
  manifest.performanceSummary = outcome.performanceSummary
    ? path.basename(summaryPath) : null;
  manifest.performanceSummarySha256 = outcome.performanceSummary
    ? sha256(summaryPath) : null;
  manifest.transactionEvidence = transactionEvidenceEnabled ? {
    ...manifest.transactionEvidence,
    transactions: outcome.transactionEvidence ? path.basename(transactionsPath) : null,
    transactionsSha256: outcome.transactionEvidence ? sha256(transactionsPath) : null,
    summary: outcome.transactionEvidence ? path.basename(transactionSummaryPath) : null,
    summarySha256: outcome.transactionEvidence ? sha256(transactionSummaryPath) : null,
    error: outcome.transactionEvidenceError,
  } : null;
  manifest.failedTransactions = outcome.failedTransactions;
  manifest.reportCreated = outcome.reportCreated;
  manifest.reportSha256 = outcome.reportCreated ? sha256(reportPath) : null;
  manifest.logSha256 = sha256(logPath);
  manifest.status = outcome.passed ? 'completed' : 'failed';
  manifest.failureReason = outcome.failureReason;
  writeManifest(manifestPath, manifest);

  process.stdout.write(`\nRun artifacts: ${runDirectory}\n`);
  if (!outcome.passed) {
    throw new Error(
      `${outcome.failureReason}. Read the retained log: ${logPath}`
    );
  }
  process.stdout.write(`Open report: ${reportPath}\n`);
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  configureTransactionEvidence,
  copyWorkloads,
  copyTransactionObservers,
  dockerHost,
  inspectOutcome,
  parseTransactionEvidence,
  parseTransactionEvidenceFiles,
  parseTransactionEvidenceLine,
  parseSummaryTableHtml,
  resourceMonitorModules,
  summarizeTransactions,
};
