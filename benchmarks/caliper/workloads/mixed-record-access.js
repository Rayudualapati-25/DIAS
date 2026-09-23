'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

function mixedScheduleSlot(sequence, workerIndex) {
  return (sequence + (workerIndex * 7)) % 10;
}

class MixedRecordAccessWorkload extends WorkloadModuleBase {
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
        throw new Error(`mixed-record-access workload requires '${field}'`);
      }
    }

    if (Number(roundArguments.readPercent) !== 70) {
      throw new Error("mixed-record-access workload requires 'readPercent' to equal 70");
    }
    if (!Number.isInteger(workerIndex) || workerIndex < 0) {
      throw new Error('mixed-record-access workload requires a non-negative worker index');
    }
    if (!Number.isInteger(totalWorkers) || totalWorkers < 1 || workerIndex >= totalWorkers) {
      throw new Error('mixed-record-access workload received an invalid total worker count');
    }

    this.workerIndex = workerIndex;
    this.totalWorkers = totalWorkers;
    this.sequence = 0;
    this.readCount = 0;
    this.writeCount = 0;
  }

  async submitTransaction() {
    // Seven slots are reads and three are writes in every complete ten-call
    // cycle for each worker. The coprime worker offset staggers write slots so
    // workers do not all switch operation type at the same time.
    const scheduleSlot = mixedScheduleSlot(this.sequence, this.workerIndex);
    this.sequence += 1;

    let request;
    if (scheduleSlot < 7) {
      this.readCount += 1;
      request = {
        contractId: this.roundArguments.contractId,
        contractFunction: 'RecordContract:GetRecord',
        contractArguments: [this.roundArguments.recordId],
        invokerIdentity: this.roundArguments.invokerIdentity,
        invokerMspId: this.roundArguments.invokerMspId,
        readOnly: true,
      };
    } else {
      this.writeCount += 1;
      const environment = {
        purpose: this.roundArguments.purpose,
        emergencyFlag: false,
      };
      request = {
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
      };
    }

    await this.sutAdapter.sendRequests(request);
  }

  async cleanupWorkloadModule() {
    const summary = {
      workerIndex: this.workerIndex,
      roundIndex: this.roundIndex,
      readCount: this.readCount,
      writeCount: this.writeCount,
      total: this.readCount + this.writeCount,
    };
    process.stdout.write(`CALIPER_MIXED_WORKLOAD_SUMMARY ${JSON.stringify(summary)}\n`);
    await super.cleanupWorkloadModule();
  }
}

function createWorkloadModule() {
  return new MixedRecordAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
module.exports.mixedScheduleSlot = mixedScheduleSlot;
