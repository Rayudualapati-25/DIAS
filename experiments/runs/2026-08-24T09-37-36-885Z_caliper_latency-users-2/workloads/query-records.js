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
      if (roundArguments[field] === undefined || roundArguments[field] === null) {
        throw new Error(`query-records workload requires '${field}'`);
      }
    }
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests({
      contractId: this.roundArguments.contractId,
      contractFunction: 'RecordContract:QueryRecords',
      contractArguments: [JSON.stringify(this.roundArguments.filters)],
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
