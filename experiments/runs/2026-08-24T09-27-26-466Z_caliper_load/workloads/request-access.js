'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

class RequestAccessWorkload extends WorkloadModuleBase {
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
      'contractId', 'recordId', 'action', 'purpose',
      'invokerIdentity', 'invokerMspId',
    ]) {
      if (!roundArguments[field]) {
        throw new Error(`request-access workload requires '${field}'`);
      }
    }
  }

  async submitTransaction() {
    const environment = {
      purpose: this.roundArguments.purpose,
      emergencyFlag: false,
    };
    await this.sutAdapter.sendRequests({
      contractId: this.roundArguments.contractId,
      contractFunction: 'AccessContract:RequestAccess',
      contractArguments: [
        this.roundArguments.recordId,
        this.roundArguments.action,
        JSON.stringify(environment),
      ],
      invokerIdentity: this.roundArguments.invokerIdentity,
      invokerMspId: this.roundArguments.invokerMspId,
      readOnly: false,
    });
  }
}

function createWorkloadModule() {
  return new RequestAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
