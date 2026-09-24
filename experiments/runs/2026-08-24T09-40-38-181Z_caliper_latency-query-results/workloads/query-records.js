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
    if (!result || result.GetStatus() !== 'success') {
      throw new Error('QueryRecords did not complete successfully');
    }
    const raw = result.GetResult();
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    const records = JSON.parse(text);
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
