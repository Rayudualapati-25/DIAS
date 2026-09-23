'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configureTransactionEvidence,
  inspectOutcome,
  parseSummaryTableHtml,
  parseTransactionEvidence,
  parseTransactionEvidenceLine,
  summarizeTransactions,
} = require('./run-benchmark');
const {
  extractJsonCandidate,
  parseCaliperJsonResult,
  resultBytesToText,
} = require('../workloads/result-json');
const { mixedScheduleSlot } = require('../workloads/mixed-record-access');

const report = `
<div id="benchmarksummary">
  <table>
    <tr>
      <th>Name</th><th>Succ</th><th>Fail</th><th>Send Rate (TPS)</th>
      <th>Max Latency (s)</th><th>Min Latency (s)</th>
      <th>Avg Latency (s)</th><th>Throughput (TPS)</th>
    </tr>
    <tr>
      <td>record-read-connectivity</td><td>10</td><td>0</td><td>1.0</td>
      <td>0.12</td><td>0.03</td><td>0.05</td><td>1.0</td>
    </tr>
    <tr>
      <td>contextual-access-connectivity</td><td>0</td><td>15</td><td>1.0</td>
      <td>-</td><td>-</td><td>-</td><td>0.9</td>
    </tr>
  </table>
</div>`;

const parsed = parseSummaryTableHtml(report);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], {
  label: 'record-read-connectivity',
  successfulTransactions: 10,
  failedTransactions: 0,
  observedSendRateTps: 1,
  latencyMaxSeconds: 0.12,
  latencyMinSeconds: 0.03,
  latencyAverageSeconds: 0.05,
  throughputTps: 1,
});
assert.equal(parsed[1].failedTransactions, 15);
assert.equal(parsed[1].latencyAverageSeconds, null);
assert.equal(parsed[1].throughputTps, 0.9);

const encodedResult = Uint8Array.from(Buffer.from('{"verified":true}', 'utf8'));
assert.equal(resultBytesToText(encodedResult), '{"verified":true}');
assert.deepEqual(parseCaliperJsonResult({
  GetStatus: () => 'success',
  GetResult: () => encodedResult,
}, 'FixtureOperation'), { verified: true });
assert.throws(
  () => parseCaliperJsonResult({ GetStatus: () => 'failed' }, 'FixtureOperation'),
  /did not complete successfully/
);

const sourceBenchmark = {
  test: { rounds: [] },
  monitors: { resource: [{ module: 'docker' }] },
};
const configuredBenchmark = configureTransactionEvidence(sourceBenchmark, { enabled: true });
assert.equal(sourceBenchmark.monitors.transaction, undefined);
assert.equal(configuredBenchmark.monitors.transaction.length, 1);
assert.equal(configuredBenchmark.monitors.transaction[0].module, 'monitors/latency-tx-observer.js');
const alreadyConfigured = configureTransactionEvidence({
  test: { rounds: [] },
  monitors: {
    transaction: [{ module: './monitors/latency-tx-observer.js', options: {} }],
  },
}, { enabled: true });
assert.equal(alreadyConfigured.monitors.transaction.length, 1);
const unchangedBenchmark = configureTransactionEvidence(sourceBenchmark, { enabled: false });
assert.equal(unchangedBenchmark, sourceBenchmark);

assert.equal(parseTransactionEvidenceLine('unrelated malformed log line'), null);
const txEvent = parseTransactionEvidenceLine(
  'info CALIPER_TX_LATENCY {"roundIndex":0,"roundLabel":"read","workerIndex":1,' +
  '"transactionId":"tx1","status":"success","startEpochMs":1000,"endEpochMs":1025,"latencyMs":25}'
);
assert.equal(txEvent.roundLabel, 'read');
assert.equal(txEvent.latencyMs, 25);
assert.throws(
  () => parseTransactionEvidenceLine(
    'CALIPER_TX_LATENCY {"roundIndex":0,"roundLabel":"bad","workerIndex":0,' +
    '"status":"success","startEpochMs":200,"endEpochMs":100,"latencyMs":-100}'
  ),
  /invalid timing/
);

const txSummary = summarizeTransactions([
  {
    roundIndex: 0,
    roundLabel: 'read',
    workerIndex: 0,
    transactionId: 'tx1',
    status: 'success',
    startEpochMs: 1000,
    endEpochMs: 1010,
    latencyMs: 10,
  },
  {
    roundIndex: 0,
    roundLabel: 'read',
    workerIndex: 1,
    transactionId: 'tx2',
    status: 'failed',
    startEpochMs: 1000,
    endEpochMs: 1030,
    latencyMs: 30,
  },
], [{
  label: 'read',
  successfulTransactions: 1,
  failedTransactions: 1,
}]);
assert.equal(txSummary.transactions, 2);
assert.equal(txSummary.rounds[0].successfulTransactions, 1);
assert.equal(txSummary.rounds[0].failedTransactions, 1);
assert.equal(txSummary.rounds[0].latencyMs.mean, 20);
assert.equal(txSummary.rounds[0].latencyMs.p50, 20);
assert.throws(
  () => summarizeTransactions(txSummary.rounds, [{
    label: 'read',
    successfulTransactions: 99,
    failedTransactions: 0,
  }]),
  /count mismatch|missing/
);

let scheduledReads = 0;
let scheduledWrites = 0;
for (let workerIndex = 0; workerIndex < 4; workerIndex += 1) {
  let workerReads = 0;
  let workerWrites = 0;
  for (let sequence = 0; sequence < 10; sequence += 1) {
    if (mixedScheduleSlot(sequence, workerIndex) < 7) workerReads += 1;
    else workerWrites += 1;
  }
  assert.equal(workerReads, 7);
  assert.equal(workerWrites, 3);
  scheduledReads += workerReads;
  scheduledWrites += workerWrites;
}
assert.equal(scheduledReads, 28);
assert.equal(scheduledWrites, 12);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'caliper-runner-test-'));
try {
  const reportPath = path.join(temporaryDirectory, 'report.html');
  const logPath = path.join(temporaryDirectory, 'caliper.log');
  fs.writeFileSync(reportPath, report);
  fs.writeFileSync(
    logPath,
    'Total rounds: 2. Successful rounds: 2. Failed rounds: 0.\n'
  );

  const formalOutcome = inspectOutcome(logPath, reportPath, 0, {
    roundPhases: {
      'record-read-connectivity': 'warmup',
      'contextual-access-connectivity': 'measurement',
    },
  });
  assert.equal(formalOutcome.passed, true);
  assert.equal(formalOutcome.failedTransactions, 15);
  assert.equal(formalOutcome.performanceSummary[0].phase, 'warmup');
  assert.equal(formalOutcome.performanceSummary[1].phase, 'measurement');

  const smokeOutcome = inspectOutcome(logPath, reportPath, 0, {
    requireZeroTransactionFailures: true,
  });
  assert.equal(smokeOutcome.passed, false);
  assert.equal(smokeOutcome.failureReason, 'Caliper reported 15 failed transaction(s)');

  const txLogPath = path.join(temporaryDirectory, 'caliper-tx.log');
  fs.writeFileSync(
    txLogPath,
    [
      'noise',
      'CALIPER_TX_LATENCY {"roundIndex":0,"roundLabel":"record-read-connectivity",' +
        '"workerIndex":0,"transactionId":"tx1","status":"success",' +
        '"startEpochMs":1000,"endEpochMs":1050,"latencyMs":50}',
      'CALIPER_TX_LATENCY {"roundIndex":0,"roundLabel":"record-read-connectivity",' +
        '"workerIndex":0,"transactionId":"tx1","status":"success",' +
        '"startEpochMs":1000,"endEpochMs":1050,"latencyMs":50}',
      'more noise',
    ].join('\n')
  );
assert.equal(parseTransactionEvidence(txLogPath, { required: true }).length, 1);
  fs.writeFileSync(txLogPath, 'noise only\n');
  assert.throws(
    () => parseTransactionEvidence(txLogPath, { required: true }),
    /no transaction evidence/
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}

assert.equal(resultBytesToText(Buffer.from('{"a":1}')), '{"a":1}');
assert.equal(extractJsonCandidate('  noise {"a":1} trailing '), '{"a":1}');
assert.deepEqual(parseCaliperJsonResult({
  GetStatus: () => 'success',
  GetResult: () => Buffer.from('prefix {"decision":{"reasonCode":"POLICY_SATISFIED"}} suffix'),
}, 'RequestAccess').decision.reasonCode, 'POLICY_SATISFIED');

process.stdout.write('Caliper runner and workload helper tests: passed\n');
