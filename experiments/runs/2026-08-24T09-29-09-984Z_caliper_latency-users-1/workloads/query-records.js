'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

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
      'contractId', 'filters', 'invokerIdentity', 'invokerMspId',
    ]) {
      if (!roundArguments[field]) {
        throw new Error(`query-records workload requires '${field}'`);
      }
    }
    this.filtersJson = typeof roundArguments.filters === 'string'
      ? roundArguments.filters : JSON.stringify(roundArguments.filters);
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests({
      contractId: this.roundArguments.contractId,
      contractFunction: 'RecordContract:QueryRecords',
      contractArguments: [this.filtersJson],
      invokerIdentity: this.roundArguments.invokerIdentity,
      invokerMspId: this.roundArguments.invokerMspId,
      readOnly: true,
    });
  }
}

function createWorkloadModule() {
  return new QueryRecordsWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
