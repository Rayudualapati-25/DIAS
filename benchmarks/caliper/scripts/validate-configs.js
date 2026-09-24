'use strict';

const fs = require('fs');
const path = require('path');
const { CaliperUtils } = require('@hyperledger/caliper-core');

const CALIPER_DIR = path.resolve(__dirname, '..');
const BASE_CONFIGS = [
  'configs/smoke.yaml',
  'configs/read-performance.yaml',
  'configs/write-performance.yaml',
  'configs/increasing-load.yaml',
  'configs/mixed-workload.yaml',
  'configs/endurance.yaml',
];
const LATENCY_CONFIGS = [
  'configs/latency-clients-1.yaml',
  'configs/latency-clients-2.yaml',
  'configs/latency-clients-4.yaml',
  'configs/latency-clients-8.yaml',
  'configs/latency-write-tps.yaml',
  'configs/latency-query-count.yaml',
  'configs/latency-policy-path.yaml',
  'configs/latency-stability-short.yaml',
];
const CONFIGS = [...BASE_CONFIGS, ...LATENCY_CONFIGS];
const ALLOWED_POLICE_IDENTITIES = new Set([
  'io.krishnan', 'insp.rathore', 'insp.singh', 'const.verma', 'insp.sharma',
]);
const ALLOWED_RATE_CONTROLLERS = new Set(['fixed-rate', 'linear-rate']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function positiveNumber(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateRound(round, index, configPath) {
  const location = `${configPath}: test.rounds[${index}]`;
  assert(typeof round.label === 'string' && round.label.length > 0,
    `${location} requires a label`);
  const hasNumber = Object.hasOwn(round, 'txNumber');
  const hasDuration = Object.hasOwn(round, 'txDuration');
  assert(hasNumber !== hasDuration,
    `${location} must define exactly one of txNumber or txDuration`);
  assert(positiveNumber(hasNumber ? round.txNumber : round.txDuration),
    `${location} requires a positive transaction count or duration`);
  assert(round.rateControl && ALLOWED_RATE_CONTROLLERS.has(round.rateControl.type),
    `${location} has an unsupported rate controller`);

  if (round.rateControl.type === 'fixed-rate') {
    assert(positiveNumber(round.rateControl.opts && round.rateControl.opts.tps),
      `${location} fixed-rate requires positive opts.tps`);
  } else {
    assert(positiveNumber(round.rateControl.opts && round.rateControl.opts.startingTps),
      `${location} linear-rate requires positive opts.startingTps`);
    assert(positiveNumber(round.rateControl.opts && round.rateControl.opts.finishingTps),
      `${location} linear-rate requires positive opts.finishingTps`);
  }

  assert(round.workload && typeof round.workload.module === 'string',
    `${location} requires a workload module`);
  const modulePath = path.resolve(CALIPER_DIR, round.workload.module);
  assert(modulePath.startsWith(`${CALIPER_DIR}${path.sep}`),
    `${location} workload must remain inside the Caliper workspace`);
  assert(fs.existsSync(modulePath), `${location} workload does not exist: ${modulePath}`);
  assert(round.workload.arguments && round.workload.arguments.contractId === 'crimerecords',
    `${location} must target the deployed crimerecords chaincode`);
  assert(ALLOWED_POLICE_IDENTITIES.has(round.workload.arguments.invokerIdentity),
    `${location} uses an identity outside the frozen Police benchmark set`);
  assert(round.workload.arguments.invokerMspId === 'PoliceMSP',
    `${location} must use PoliceMSP`);
  if (round.workload.module === 'workloads/query-records.js') {
    assert(Number.isInteger(Number(round.workload.arguments.expectedCount))
      && Number(round.workload.arguments.expectedCount) >= 0,
    `${location} query workload requires a non-negative expectedCount`);
  }
  if (round.workload.module === 'workloads/request-access-verified.js') {
    assert(typeof round.workload.arguments.expectedReasonCode === 'string'
      && round.workload.arguments.expectedReasonCode.length > 0,
    `${location} verified write workload requires expectedReasonCode`);
  }
}

function validateConfig(relativePath) {
  const absolutePath = path.join(CALIPER_DIR, relativePath);
  assert(fs.existsSync(absolutePath), `configuration is missing: ${relativePath}`);
  const config = CaliperUtils.parseYaml(absolutePath);
  assert(config.test && config.test.workers,
    `${relativePath} requires test.workers`);
  assert(Number.isInteger(config.test.workers.number) && config.test.workers.number > 0,
    `${relativePath} requires a positive integer worker count`);
  assert(Array.isArray(config.test.rounds) && config.test.rounds.length > 0,
    `${relativePath} requires at least one round`);
  config.test.rounds.forEach((round, index) => validateRound(round, index, relativePath));
  const labels = config.test.rounds.map((round) => round.label);
  assert(new Set(labels).size === labels.length, `${relativePath} round labels must be unique`);

  const transactionMonitors = config.monitors && config.monitors.transaction
    ? config.monitors.transaction : [];
  if (LATENCY_CONFIGS.includes(relativePath)) {
    assert(transactionMonitors.length === 1
      && transactionMonitors[0].module.replace(/^\.\//, '')
        === 'monitors/latency-tx-observer.js',
    `${relativePath} must enable only the retained latency transaction observer`);
  } else if (transactionMonitors.length > 0) {
    throw new Error(`${relativePath} must not enable optional transaction monitors`);
  }
  if (relativePath !== 'configs/smoke.yaml') {
    const resourceMonitors = config.monitors && config.monitors.resource
      ? config.monitors.resource : [];
    const modules = new Set(resourceMonitors.map((monitor) => monitor.module));
    assert(modules.has('prometheus'), `${relativePath} requires Prometheus resource monitoring`);
    const dockerMonitor = resourceMonitors.find((monitor) => monitor.module === 'docker');
    if (!LATENCY_CONFIGS.includes(relativePath)) {
      assert(dockerMonitor, `${relativePath} requires Docker resource monitoring`);
    }
    if (dockerMonitor) {
      assert(dockerMonitor.options && Array.isArray(dockerMonitor.options.containers)
        && dockerMonitor.options.containers.includes('all'),
      `${relativePath} Docker monitoring must include all containers`);
    }
    const prometheusMonitor = resourceMonitors.find(
      (monitor) => monitor.module === 'prometheus'
    );
    assert(prometheusMonitor.options
      && prometheusMonitor.options.url === 'http://127.0.0.1:9090',
      `${relativePath} must use the local IPv4 Prometheus endpoint`);
    const queries = prometheusMonitor.options.metrics
      && prometheusMonitor.options.metrics.queries;
    assert(Array.isArray(queries) && queries.length === 4,
      `${relativePath} must define all four Prometheus queries`);
    for (const query of queries) {
      assert(typeof query.name === 'string' && typeof query.query === 'string',
        `${relativePath} contains an incomplete Prometheus query`);
      assert(positiveNumber(query.step) && query.label === 'instance',
        `${relativePath} Prometheus queries require a positive step and instance label`);
      assert(['max', 'avg'].includes(query.statistic),
        `${relativePath} Prometheus query uses an unsupported statistic`);
    }
  }

  return {
    path: relativePath,
    workers: config.test.workers.number,
    rounds: config.test.rounds.length,
    durationSeconds: config.test.rounds.reduce(
      (total, round) => total + Number(round.txDuration || 0), 0
    ),
  };
}

function validatePlannedProfiles() {
  const parsed = Object.fromEntries(CONFIGS.map((relativePath) => [
    relativePath,
    CaliperUtils.parseYaml(path.join(CALIPER_DIR, relativePath)),
  ]));
  const loadTps = parsed['configs/increasing-load.yaml'].test.rounds
    .map((round) => Number(round.rateControl.opts.tps));
  assert(JSON.stringify(loadTps) === JSON.stringify([1, 2, 5, 10, 20]),
    'increasing-load.yaml must preserve the declared 1/2/5/10/20 TPS steps');
  const mixedArguments = parsed['configs/mixed-workload.yaml'].test.rounds
    .map((round) => round.workload.arguments);
  assert(mixedArguments.every((arguments_) => Number(arguments_.readPercent) === 70),
    'mixed-workload.yaml must preserve the exact 70/30 split');
  const endurance = parsed['configs/endurance.yaml'].test.rounds
    .find((round) => round.label === 'endurance-70-read-30-write');
  assert(endurance && Number(endurance.txDuration) === 7200,
    'endurance.yaml must preserve the declared two-hour measured round');
  assert(Number(endurance.rateControl.opts.tps) === 5
    && Number(endurance.workload.arguments.readPercent) === 70,
  'endurance.yaml must preserve the declared 5 TPS deterministic 70/30 profile');

  for (const workers of [1, 2, 4, 8]) {
    const profile = parsed[`configs/latency-clients-${workers}.yaml`];
    assert(profile.test.workers.number === workers,
      `latency-clients-${workers}.yaml must use ${workers} worker(s)`);
    assert(profile.test.rounds.at(-1).label === `clients-${workers}-read`,
      `latency-clients-${workers}.yaml requires the frozen measurement label`);
  }
  const writeRates = parsed['configs/latency-write-tps.yaml'].test.rounds
    .filter((round) => !round.label.includes('warmup'))
    .map((round) => Number(round.rateControl.opts.tps));
  assert(JSON.stringify(writeRates) === JSON.stringify([1, 2, 5, 10, 20]),
    'latency-write-tps.yaml must preserve the declared 1/2/5/10/20 TPS points');
  const queryCounts = parsed['configs/latency-query-count.yaml'].test.rounds
    .filter((round) => !round.label.includes('warmup'))
    .map((round) => Number(round.workload.arguments.expectedCount));
  assert(JSON.stringify(queryCounts) === JSON.stringify([1, 2, 3]),
    'latency-query-count.yaml must preserve verified result counts 1/2/3');
  const queryRates = parsed['configs/latency-query-count.yaml'].test.rounds
    .filter((round) => !round.label.includes('warmup'))
    .map((round) => Number(round.rateControl.opts.tps));
  assert(queryRates.every((rate) => rate === 1),
    'latency-query-count.yaml must keep every measured query below saturation at 1 TPS');
  const policyReasons = parsed['configs/latency-policy-path.yaml'].test.rounds
    .filter((round) => !round.label.includes('warmup'))
    .map((round) => round.workload.arguments.expectedReasonCode);
  assert(JSON.stringify(policyReasons) === JSON.stringify([
    'CRED_NOT_ACTIVE', 'RBAC_NO_PERMISSION', 'CROSS_JURISDICTION',
    'NOT_ASSIGNED', 'POLICY_SATISFIED',
  ]), 'latency-policy-path.yaml must preserve the five verified policy paths');
  const stabilityBins = parsed['configs/latency-stability-short.yaml'].test.rounds
    .filter((round) => /^stability-bin-\d{2}$/.test(round.label));
  assert(stabilityBins.length === 10
    && stabilityBins.every((round) => Number(round.txDuration) === 30),
  'latency-stability-short.yaml must preserve ten 30-second measurement bins');
}

function validateAll() {
  const summaries = CONFIGS.map(validateConfig);
  validatePlannedProfiles();
  return summaries;
}

if (require.main === module) {
  try {
    const summaries = validateAll();
    for (const summary of summaries) {
      process.stdout.write(
        `${summary.path}: ${summary.workers} worker(s), ${summary.rounds} round(s), ${summary.durationSeconds}s configured\n`
      );
    }
    process.stdout.write('Caliper configuration validation: passed\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateAll, validateConfig };
