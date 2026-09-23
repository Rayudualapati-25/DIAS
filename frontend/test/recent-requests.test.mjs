/**
 * Pure-logic tests for the session-scoped recent-requests store.
 * Run with:  node --test frontend/test/
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A minimal sessionStorage stand-in; the browser API is the only global used.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const { loadRecentRequests, rememberRequest } = await import('../js/shared/recent-requests.js');

const decision = (overrides = {}) => ({
  recordId: 'REC-FIR-001',
  decisionId: 'd1',
  decision: 'escalate',
  status: 'pending-escalation',
  createdAtUtc: '2026-09-03T10:00:00.000Z',
  ...overrides,
});

beforeEach(() => { globalThis.sessionStorage = fakeStorage(); });

test('starts empty for an identity with no requests', () => {
  assert.deepEqual(loadRecentRequests('insp.sharma'), []);
});

test('remembers a request and reads it back, most recent first', () => {
  rememberRequest('insp.sharma', decision({ decisionId: 'd1' }));
  const list = rememberRequest('insp.sharma', decision({ decisionId: 'd2', decision: 'allow', status: 'granted' }));
  assert.deepEqual(list.map((e) => e.decisionId), ['d2', 'd1']);
  assert.deepEqual(loadRecentRequests('insp.sharma').map((e) => e.decisionId), ['d2', 'd1']);
});

test('updates the status of an existing decision instead of duplicating it', () => {
  rememberRequest('insp.singh', decision({ decisionId: 'd1' }));
  const list = rememberRequest('insp.singh', decision({ decisionId: 'd1', status: 'approved-after-escalation' }));
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'approved-after-escalation');
});

test('keeps identities separate', () => {
  rememberRequest('insp.sharma', decision({ decisionId: 'd1' }));
  assert.deepEqual(loadRecentRequests('const.verma'), []);
});

test('stores only identifiers and status, never explanation text', () => {
  rememberRequest('insp.sharma', decision({ explanation: { text: 'narrative' } }));
  const raw = globalThis.sessionStorage.getItem('crn.recent-requests.insp.sharma');
  assert.ok(!raw.includes('narrative'));
  assert.deepEqual(Object.keys(JSON.parse(raw)[0]).sort(),
    ['createdAtUtc', 'decision', 'decisionId', 'recordId', 'requestId', 'status']);
});

test('tracks a pending request before an auditor creates a decision id', () => {
  const pending = rememberRequest('insp.sharma', {
    requestId: 'REQ-9', recordId: 'REC-FIR-001',
    status: 'pending-auditor', submittedAtUtc: '2026-09-10T10:00:00.000Z',
  });
  assert.deepEqual(pending[0], {
    requestId: 'REQ-9', recordId: 'REC-FIR-001', decisionId: null,
    decision: null, status: 'pending-auditor',
    createdAtUtc: '2026-09-10T10:00:00.000Z',
  });
});

test('caps the list at ten entries and does not mutate the stored copy', () => {
  for (let i = 0; i < 12; i += 1) rememberRequest('insp.sharma', decision({ decisionId: `d${i}` }));
  const stored = loadRecentRequests('insp.sharma');
  assert.equal(stored.length, 10);
  assert.equal(stored[0].decisionId, 'd11');
  const before = JSON.stringify(stored);
  rememberRequest('insp.sharma', decision({ decisionId: 'new' }));
  assert.equal(JSON.stringify(stored), before);
});

test('survives an unavailable or corrupt storage', () => {
  globalThis.sessionStorage = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(loadRecentRequests('insp.sharma'), []);
  const list = rememberRequest('insp.sharma', decision());
  assert.equal(list.length, 1);
});
