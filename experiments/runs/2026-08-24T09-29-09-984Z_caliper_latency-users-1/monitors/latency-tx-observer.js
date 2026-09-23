'use strict';

const TxObserverInterface = require('../node_modules/@hyperledger/caliper-core/lib/worker/tx-observers/tx-observer-interface');

const MARKER = 'CALIPER_TX_LATENCY';

function valueFrom(result, getter, field) {
  if (result && typeof result[getter] === 'function') {
    return result[getter]();
  }
  return result && result.status ? result.status[field] : undefined;
}

class LatencyTxObserver extends TxObserverInterface {
  constructor(options, messenger, workerIndex) {
    super(messenger, workerIndex);
  }

  txSubmitted(count) {}

  txFinished(results) {
    const statuses = Array.isArray(results) ? results : [results];
    for (const result of statuses) {
      const startEpochMs = valueFrom(result, 'GetTimeCreate', 'time_create');
      const endEpochMs = valueFrom(result, 'GetTimeFinal', 'time_final');
      const latencyMs = Number.isFinite(startEpochMs) && Number.isFinite(endEpochMs)
        ? endEpochMs - startEpochMs : null;
      const event = {
        roundIndex: Number.isInteger(result.roundIndex) ? result.roundIndex : this.currentRound,
        roundLabel: this.roundLabel,
        workerIndex: Number.isInteger(result.workerIndex) ? result.workerIndex : this.workerIndex,
        transactionId: valueFrom(result, 'GetID', 'id') || null,
        status: valueFrom(result, 'GetStatus', 'status') || 'unknown',
        startEpochMs: Number.isFinite(startEpochMs) ? startEpochMs : null,
        endEpochMs: Number.isFinite(endEpochMs) ? endEpochMs : null,
        latencyMs,
      };
      process.stdout.write(`${MARKER} ${JSON.stringify(event)}\n`);
    }
  }
}

function createTxObserver(options, messenger, workerIndex) {
  return new LatencyTxObserver(options, messenger, workerIndex);
}

module.exports = {
  MARKER,
  createTxObserver,
};
