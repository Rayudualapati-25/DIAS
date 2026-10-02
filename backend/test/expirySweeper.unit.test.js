'use strict';

/**
 * Plan step 7, backend half: a periodic sweeper records the expiry of every
 * pending request whose review deadline has passed. The contract decides from
 * committed state whether a request is due; the sweeper only asks.
 */

const { expect } = require('chai');
const { createExpirySweeper } = require('../src/dias/expirySweeper');

const IDENTITY = Object.freeze({ org: 'audit', fabricUser: 'sp.north' });
const NOW = Date.parse('2026-08-08T12:00:05.000Z');

function pendingRequest(requestId, reviewDeadlineUtc) {
  return { request: { requestId, status: 'awaiting-auditor', reviewDeadlineUtc } };
}

function fakeLedger(pending, { failFor = [] } = {}) {
  const calls = [];
  return {
    calls,
    evaluate: async (...args) => { calls.push(['evaluate', ...args]); return pending; },
    submit: async (...args) => {
      calls.push(['submit', ...args]);
      if (failFor.includes(args[4])) throw new Error('access request is not due to expire until later');
      return { request: { requestId: args[4], status: 'expired' } };
    },
  };
}

describe('DIAS expiry sweeper', () => {
  it('expires only the pending requests whose deadline has passed', async () => {
    const ledger = fakeLedger([
      pendingRequest('REQ-DUE', '2026-08-08T12:00:00.000Z'),
      pendingRequest('REQ-LATER', '2026-08-09T12:00:00.000Z'),
      pendingRequest('REQ-NONE', null),
    ]);
    const sweeper = createExpirySweeper({ ledger, identity: IDENTITY, now: () => NOW, log: { error() {}, log() {} } });
    const results = await sweeper.sweepOnce();
    expect(results).to.deep.equal([{ requestId: 'REQ-DUE', expired: true }]);
    expect(ledger.calls).to.deep.equal([
      ['evaluate', 'audit', 'sp.north', 'AccessContract', 'QueryPendingAuditorRequests'],
      ['submit', 'audit', 'sp.north', 'AccessContract', 'ExpirePendingRequest', 'REQ-DUE'],
    ]);
  });

  it('keeps sweeping after one request is refused and reports why', async () => {
    const ledger = fakeLedger([
      pendingRequest('REQ-A', '2026-08-08T00:00:00.000Z'),
      pendingRequest('REQ-B', '2026-08-08T00:00:00.000Z'),
    ], { failFor: ['REQ-A'] });
    const sweeper = createExpirySweeper({ ledger, identity: IDENTITY, now: () => NOW, log: { error() {}, log() {} } });
    const results = await sweeper.sweepOnce();
    expect(results).to.deep.equal([
      { requestId: 'REQ-A', expired: false, error: 'access request is not due to expire until later' },
      { requestId: 'REQ-B', expired: true },
    ]);
  });

  it('does not start a timer when the interval is zero', () => {
    const sweeper = createExpirySweeper({ ledger: fakeLedger([]), identity: IDENTITY, intervalMs: 0 });
    expect(sweeper.start()).to.equal(null);
  });
});
