'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { parseCaliperJsonResult } = require('./result-json');

class QueryRecordsWorkload extends WorkloadModuleBase {
  async initializeWorkloadModule(
    workerIndex,
    totalWorkers,
    roundIndex,
    roundArguments,
    sutAdapter,
    sutContext
  ) {
    await super.initializeWorkloadModule(
      workerIndex,
      totalWorkers,
      roundIndex,
      roundArguments,
      sutAdapter,
      sutContext
    );
    for (const field of [
      'contractId', 'filters', 'expectedCount', 'invokerIdentity', 'invokerMspId',
    ]) {
      if (roundArguments[field] === undefined || roundArguments[field] === null) {
        throw new Error(`query-records workload requires '${field}'`);
      }
    }
    if (!Number.isInteger(Number(roundArguments.expectedCount))
      || Number(roundArguments.expectedCount) < 0) {
      throw new Error("query-records workload requires a non-negative integer 'expectedCount'");
    }
  }

  async submitTransaction() {
    const result = await this.sutAdapter.sendRequests({
      contractId: this.roundArguments.contractId,
      contractFunction: 'RecordContract:QueryRecords',
      contractArguments: [JSON.stringify(this.roundArguments.filters)],
      invokerIdentity: this.roundArguments.invokerIdentity,
      invokerMspId: this.roundArguments.invokerMspId,
      readOnly: true,
    });
    const records = parseCaliperJsonResult(result, 'QueryRecords');
    if (!Array.isArray(records)) {
      throw new Error('QueryRecords returned a non-array result');
    }
    const expectedCount = Number(this.roundArguments.expectedCount);
    if (records.length !== expectedCount) {
      throw new Error(
        `QueryRecords returned ${records.length} records; expected ${expectedCount}`
      );
    }
  }
}

function createWorkloadModule() {
  return new QueryRecordsWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
