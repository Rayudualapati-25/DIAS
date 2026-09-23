'use strict';

/**
 * Case-file lookup and officer registration guards.
 *
 * Lookup reads the public record index, so an officer outside the owning station
 * can find a case file before requesting access to it. Registration mirrors
 * UserContract: only a district head of the authority organisation admits an
 * officer, into any department.
 */

const { expect } = require('chai');

const { lookupRecord } = require('../src/routes/records');
const { administrationRefusal } = require('../src/routes/users');

const outsider = Object.freeze({ org: 'police', fabricUser: 'insp.singh', role: 'inspector' });

function indexLedger(items) {
  const calls = [];
  return {
    calls,
    evaluate: async (...args) => {
      calls.push(args);
      return items;
    },
  };
}

describe('case-file lookup', () => {
  it('finds a case file through the public index for an officer outside the owning station', async () => {
    const ledger = indexLedger([{
      recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', owningMsp: 'PoliceMSP',
      owningAgency: 'police', owningStation: 'PS-Central',
    }]);
    const found = await lookupRecord({ user: outsider, recordId: 'REC-FIR-001', ledger });
    expect(found).to.deep.equal({
      status: 200,
      data: {
        recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', owningMsp: 'PoliceMSP',
        owningAgency: 'police', owningStation: 'PS-Central',
      },
    });
    expect(ledger.calls).to.deep.equal([[
      'police', 'insp.singh', 'RecordContract', 'QueryRecords', '{"recordId":"REC-FIR-001"}',
    ]]);
  });

  it('answers 404 when the index holds no such case file', async () => {
    const found = await lookupRecord({ user: outsider, recordId: 'REC-NONE', ledger: indexLedger([]) });
    expect(found).to.deep.equal({ status: 404, error: 'case file not found' });
  });

  it('refuses a malformed identifier before reaching the ledger', async () => {
    const ledger = indexLedger([]);
    const found = await lookupRecord({ user: outsider, recordId: 'REC 1', ledger });
    expect(found.status).to.equal(400);
    expect(ledger.calls).to.deep.equal([]);
  });

  it('returns only the public index fields even if more come back', async () => {
    const ledger = indexLedger([{
      recordId: 'REC-FIR-001', caseId: 'CASE-2026-001', owningMsp: 'PoliceMSP',
      owningAgency: 'police', owningStation: 'PS-Central', offChainReference: 'vault://police/x',
    }]);
    const found = await lookupRecord({ user: outsider, recordId: 'REC-FIR-001', ledger });
    expect(found.data).to.not.have.property('offChainReference');
  });
});

describe('officer administration guard', () => {
  it('lets a district head of the authority organisation admit officers to any department', () => {
    expect(administrationRefusal({ org: 'audit', role: 'sp' })).to.equal(null);
    expect(administrationRefusal({ org: 'audit', role: 'district-judge' })).to.equal(null);
  });

  it('refuses everyone else before a certificate is issued', () => {
    for (const user of [
      { org: 'police', role: 'inspector' },
      { org: 'police', role: 'sp' },
      { org: 'audit', role: 'circle-inspector' },
    ]) {
      const refusal = administrationRefusal(user);
      expect(refusal.status).to.equal(403);
      expect(refusal.error).to.match(/district head of the authority organisation/);
    }
  });
});
