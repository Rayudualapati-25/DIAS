'use strict';

/**
 * Fabric commit conflicts.
 *
 * A transaction that loses an MVCC or phantom-read race is rejected at commit and
 * writes nothing, so proposing it again against the new state is safe. The API
 * retries a few times and, if the race keeps being lost, says so plainly instead
 * of answering "internal error".
 */

const { expect } = require('chai');

const {
  COMMIT_CONFLICT_CODES, isCommitConflict, withCommitRetry,
} = require('../src/fabric/commitErrors');
const { asyncRoute } = require('../src/util/respond');

function commitError(code) {
  const error = new Error(`Transaction tx-1 failed to commit with status code ${code}`);
  error.name = 'CommitError';
  error.code = code;
  error.transactionId = 'tx-1';
  return error;
}

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Fabric commit conflicts', () => {
  const noSleep = async () => {};

  it('recognises only MVCC and phantom-read commit failures as conflicts', () => {
    expect(COMMIT_CONFLICT_CODES).to.deep.equal([11, 12]);
    expect(isCommitConflict(commitError(11))).to.equal(true);
    expect(isCommitConflict(commitError(12))).to.equal(true);
    expect(isCommitConflict(commitError(10))).to.equal(false);
    expect(isCommitConflict(new Error('MVCC_READ_CONFLICT'))).to.equal(false);
    expect(isCommitConflict(null)).to.equal(false);
  });

  it('proposes the transaction again after a conflict and returns the committed result', async () => {
    let attempts = 0;
    const result = await withCommitRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw commitError(11);
      return 'committed';
    }, { retries: 3, sleep: noSleep });
    expect(result).to.equal('committed');
    expect(attempts).to.equal(3);
  });

  it('gives up after the retry budget and rethrows the conflict', async () => {
    let attempts = 0;
    const failing = withCommitRetry(async () => {
      attempts += 1;
      throw commitError(12);
    }, { retries: 2, sleep: noSleep });
    await failing.then(
      () => expect.fail('expected the conflict to be rethrown'),
      (error) => expect(error.code).to.equal(12),
    );
    expect(attempts).to.equal(3);
  });

  it('never retries a chaincode refusal or any other failure', async () => {
    let attempts = 0;
    const refusal = Object.assign(new Error('endorse failed'), { details: [{ message: 'unauthorized' }] });
    await withCommitRetry(async () => {
      attempts += 1;
      throw refusal;
    }, { retries: 3, sleep: noSleep }).catch((error) => expect(error).to.equal(refusal));
    expect(attempts).to.equal(1);
  });

  it('answers a conflict that survives the retries with 409 and a plain explanation', async () => {
    const res = fakeResponse();
    await asyncRoute(async () => { throw commitError(11); })({ method: 'POST', originalUrl: '/api/x' }, res);
    expect(res.statusCode).to.equal(409);
    expect(res.body.success).to.equal(false);
    expect(res.body.error).to.match(/ledger changed.*nothing was recorded.*try again/i);
  });
});
