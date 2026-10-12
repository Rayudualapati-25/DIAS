import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchForAccess } from '../js/shared/search-access.js';

const intent = { identifier: 'REC-1', kind: 'record', action: 'view',
  purpose: 'investigation', justification: 'Investigating the case.' };
const record = { recordId: 'REC-1', caseId: 'CASE-1', owningStation: 'PS-1' };
function fixture(targets = [record]) {
  const calls = [];
  const api = {
    records: { lookup: async () => record, search: async () => targets,
      evidenceIndex: async () => targets },
    access: { request: async (body) => { calls.push(body); return { requestId: 'REQ-1',
      status: 'awaiting-auditor' }; } },
  };
  return { api, calls };
}
test('Search on one file automatically submits its scoped access request', async () => {
  const { api, calls } = fixture();
  const found = await searchForAccess({ api, input: intent });
  assert.equal(found.request.requestId, 'REQ-1');
  assert.deepEqual(calls, [{ recordId: 'REC-1', action: 'view', purpose: 'investigation',
    justification: 'Investigating the case.' }]);
});
test('Search returns a reused grant unchanged; the browser never invokes a model directly', async () => {
  const { api } = fixture();
  api.access.request = async () => ({ status: 'granted', processingPath: 'dynamic-authorization' });
  const found = await searchForAccess({ api, input: intent });
  assert.equal(found.request.processingPath, 'dynamic-authorization');
});
test('a case with multiple files requests only the file the user selects', async () => {
  const { api, calls } = fixture([record, { ...record, recordId: 'REC-2' }]);
  const found = await searchForAccess({ api, input: { ...intent, identifier: 'CASE-1', kind: 'case' } });
  assert.equal(found.targets.length, 2);
  assert.equal(found.request, null);
  assert.equal(calls.length, 0);
});
test('an evidence identifier requests access to its parent case file', async () => {
  const { api, calls } = fixture();
  await searchForAccess({ api, input: { ...intent, kind: 'evidence', identifier: 'EV-1' } });
  assert.equal(calls[0].recordId, 'REC-1');
});
test('unknown identifiers and missing reasons never create access requests', async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(searchForAccess({ api, input: { ...intent, kind: 'case' } }), /not found/i);
  await assert.rejects(searchForAccess({ api, input: { ...intent, justification: '  ' } }), /reason/i);
  assert.equal(calls.length, 0);
});
