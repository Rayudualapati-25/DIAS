'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

function parseResult(result) {
  if (!result || result.GetStatus() !== 'success') {
    throw new Error('RequestAccess did not commit successfully');
  }
  const raw = result.GetResult();
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  return JSON.parse(text);
}

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
    const event = parseResult(result);
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
