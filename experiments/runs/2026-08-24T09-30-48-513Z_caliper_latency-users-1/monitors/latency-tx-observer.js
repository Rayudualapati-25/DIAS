'use strict';

const fs = require('fs');
const path = require('path');
const TxObserverInterface = require('../node_modules/@hyperledger/caliper-core/lib/worker/tx-observers/tx-observer-interface');

function resultRows(results) {
  return Array.isArray(results) ? results : [results];
}

class LatencyTxObserver extends TxObserverInterface {
  constructor(options, messenger, workerIndex) {
    super(messenger, workerIndex);
    this.options = options || {};
    this.workerIndex = workerIndex;
    this.outputDirectory = process.env.CALIPER_LATENCY_OBSERVER_DIR
      || this.options.outputDirectory
      || path.resolve(__dirname, '..', 'generated');
    fs.mkdirSync(this.outputDirectory, { recursive: true });
    this.outputPath = path.join(
      this.outputDirectory,
      `latency-transactions-worker-${workerIndex}.ndjson`
    );
  }

  txSubmitted(count) {
    super.txSubmitted(count);
  }

  txFinished(results) {
    super.txFinished(results);
    const lines = resultRows(results).map((result) => {
      const created = result.GetTimeCreate();
      const final = result.GetTimeFinal();
      return JSON.stringify({
        workerIndex: this.workerIndex,
        roundIndex: this.currentRound,
        roundLabel: this.roundLabel,
        txId: result.GetID(),
        status: result.GetStatus(),
        createdAtMs: created,
        finishedAtMs: final,
        latencyMs: final && created ? final - created : null,
      });
    });
    fs.appendFileSync(this.outputPath, `${lines.join('\n')}\n`);
  }
}

function createTxObserver(options, messenger, workerIndex) {
  return new LatencyTxObserver(options, messenger, workerIndex);
}

module.exports.createTxObserver = createTxObserver;
