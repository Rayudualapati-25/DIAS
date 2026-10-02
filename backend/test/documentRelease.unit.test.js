'use strict';

/**
 * Plan step 4, backend half: the full-document download asks the ledger to
 * re-check the grant before it touches the vault, and still compares the vault
 * bytes with the committed content hash before delivering anything.
 */

const { expect } = require('chai');
const { releaseDocument } = require('../src/routes/records');

const requester = Object.freeze({ org: 'police', fabricUser: 'insp.test', role: 'inspector' });
const AUTHORIZED = Object.freeze({
  requestId: 'DOC-1', recordId: 'FIR-1', decisionId: 'D-1', contentHash: 'b'.repeat(64),
  offChainReference: 'vault-pdf://police/DOC-1', fileName: 'case-file.pdf', mimeType: 'application/pdf',
});

function fakeVault(currentHash) {
  const reads = [];
  return {
    reads,
    readDocument: (reference) => {
      reads.push(reference);
      return { bytes: Buffer.from('%PDF-1.7'), currentHash };
    },
  };
}

describe('full-document release', () => {
  it('reads the vault only after the ledger re-checks the grant, and delivers matching bytes', async () => {
    const calls = [];
    const ledger = { evaluate: async (...args) => { calls.push(args); return AUTHORIZED; } };
    const vault = fakeVault('b'.repeat(64));
    const released = await releaseDocument({ user: requester, requestId: 'DOC-1', ledger, vault });
    expect(calls).to.deep.equal([[
      'police', 'insp.test', 'RecordContract', 'AuthorizeRequestedDocumentRead', 'DOC-1',
    ]]);
    expect(vault.reads).to.deep.equal(['vault-pdf://police/DOC-1']);
    expect(released.status).to.equal(200);
    expect(released.bytes.toString()).to.equal('%PDF-1.7');
    expect(released.headers['Cache-Control']).to.equal('private, no-store');
  });

  it('never reads the vault when the ledger refuses the release', async () => {
    const refusal = Object.assign(new Error('endorse failed'), {
      details: [{ message: 'unauthorized: the requester credential is not active at release time' }],
    });
    const ledger = { evaluate: async () => { throw refusal; } };
    const vault = fakeVault('b'.repeat(64));
    await releaseDocument({ user: requester, requestId: 'DOC-1', ledger, vault })
      .then(() => expect.fail('expected the refusal to propagate'), (error) => expect(error).to.equal(refusal));
    expect(vault.reads).to.deep.equal([]);
  });

  it('answers 409 and delivers nothing when the vault bytes do not match the committed hash', async () => {
    const ledger = { evaluate: async () => AUTHORIZED };
    const released = await releaseDocument({
      user: requester, requestId: 'DOC-1', ledger, vault: fakeVault('c'.repeat(64)),
    });
    expect(released).to.deep.equal({ status: 409, error: 'PDF integrity check failed' });
  });

  it('refuses a malformed request identifier before reaching the ledger', async () => {
    const ledger = { evaluate: async () => expect.fail('the ledger must not be called') };
    const released = await releaseDocument({
      user: requester, requestId: 'DOC 1', ledger, vault: fakeVault('b'.repeat(64)),
    });
    expect(released.status).to.equal(400);
  });
});
