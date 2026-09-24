'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class ReadRecordWorkload extends WorkloadModuleBase {
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
      'contractId', 'recordId', 'invokerIdentity', 'invokerMspId',
    ]) {
      if (!roundArguments[field]) {
        throw new Error(`read-record workload requires '${field}'`);
      }
    }
  }

  async submitTransaction() {
    await this.sutAdapter.sendRequests({
      contractId: this.roundArguments.contractId,
      contractFunction: 'RecordContract:GetRecord',
      contractArguments: [this.roundArguments.recordId],
      invokerIdentity: this.roundArguments.invokerIdentity,
      invokerMspId: this.roundArguments.invokerMspId,
      readOnly: true,
    });
  }
}

function createWorkloadModule() {
  return new ReadRecordWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
