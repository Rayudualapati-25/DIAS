'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const { parseCaliperJsonResult } = require('./result-json');

class RequestAccessVerifiedWorkload extends WorkloadModuleBase {
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
      'expectedReasonCode', 'invokerIdentity', 'invokerMspId',
    ]) {
      if (!roundArguments[field]) {
        throw new Error(`request-access-verified workload requires '${field}'`);
      }
    }
  }

  async submitTransaction() {
    const environment = {
      purpose: this.roundArguments.purpose,
      emergencyFlag: Boolean(this.roundArguments.emergencyFlag),
    };
    const result = await this.sutAdapter.sendRequests({
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
    const event = parseCaliperJsonResult(result, 'RequestAccess');
    const actual = event && event.explanation && event.explanation.reasonCode;
    if (actual !== this.roundArguments.expectedReasonCode) {
      throw new Error(
        `RequestAccess returned reason '${actual}'; expected '${this.roundArguments.expectedReasonCode}'`
      );
    }
  }
}

function createWorkloadModule() {
  return new RequestAccessVerifiedWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
