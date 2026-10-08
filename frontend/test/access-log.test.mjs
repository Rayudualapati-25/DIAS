import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accessTargetSummary } from '../js/shared/access-log.js';

test('shows the record and committed request identifiers for a DIAS request', () => {
  assert.equal(accessTargetSummary({
    recordId: 'REC-1', requestId: 'REQ-1', action: 'view', purpose: 'investigation',
  }), 'record REC-1 · request REQ-1 · action view · purpose investigation');
});

test('shows public lookup filters and handles an empty target', () => {
  assert.equal(accessTargetSummary({ filters: { recordId: 'REC-1' } }),
    'search recordId=REC-1');
  assert.equal(accessTargetSummary(null), '—');
});


// ---------------------------------------------------------------------------
// The access-request log: who requested, what, the LLM recommendation, and the
// auditor decision stated together with that recommendation.
// ---------------------------------------------------------------------------

import {
  NO_FILTERS, SORT, accessRequestRow, activeFilterCount, filterAccessRows, sortAccessRows,
} from '../js/shared/access-log.js';

/** One entry as the ledger's decision log returns it. */
const ledgerEntry = (overrides = {}) => ({
  requestId: 'REQ-1',
  recordId: 'REC-FIR-001',
  caseId: 'CASE-1',
  action: 'view',
  purpose: 'investigation',
  requester: { username: 'insp.sharma', organization: 'police', role: 'inspector' },
  outcome: 'GRANTED',
  basis: 'AUDITOR_DECISION',
  auditor: { username: 'sp.north', role: 'district-sp' },
  decision: 'FORCE_ALLOW',
  llmRecommendation: 'ALLOW',
  llmAgreement: 'AGREED',
  authorizationId: null,
  decidedAtUtc: '2026-10-06T10:00:00.000Z',
  ...overrides,
});

test('states who requested what, what the LLM recommended, and the decision with that recommendation', () => {
  assert.deepEqual(accessRequestRow(ledgerEntry()), {
    requestId: 'REQ-1',
    time: '2026-10-06T10:00:00.000Z',
    who: { name: 'insp.sharma', detail: 'inspector · police' },
    what: { name: 'REC-FIR-001', detail: 'view · investigation' },
    llm: { value: 'ALLOW', label: 'ALLOW', detail: null },
    decision: { value: 'FORCE_ALLOW', label: 'FORCE ALLOW', detail: 'agreed with the LLM\'s ALLOW · by sp.north' },
  });
});

test('says when the auditor decided against the LLM, or without a recommendation', () => {
  const against = accessRequestRow(ledgerEntry({ llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED' }));
  assert.deepEqual(against.llm, { value: 'DENY', label: 'DENY', detail: null });
  assert.deepEqual(against.decision, {
    value: 'FORCE_ALLOW', label: 'FORCE ALLOW', detail: 'against the LLM\'s DENY · by sp.north',
  });

  const without = accessRequestRow(ledgerEntry({
    decision: 'FORCE_DENY', outcome: 'DENIED', llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION',
  }));
  assert.deepEqual(without.llm, { value: 'NONE', label: 'No recommendation', detail: 'the model produced none' });
  assert.deepEqual(without.decision, {
    value: 'FORCE_DENY', label: 'FORCE DENY', detail: 'decided without an LLM recommendation · by sp.north',
  });
});

test('says when neither the LLM nor an auditor was involved', () => {
  const reused = accessRequestRow(ledgerEntry({
    basis: 'DYNAMIC_AUTHORIZATION', auditor: null, decision: null, llmRecommendation: null,
    llmAgreement: null, authorizationId: 'AUTH-9',
  }));
  assert.deepEqual(reused.llm, { value: 'NOT_ASKED', label: 'Not asked', detail: 'a reusable authorization matched' });
  assert.deepEqual(reused.decision, {
    value: 'NONE', label: 'Not needed', detail: 'granted by reusable authorization AUTH-9',
  });

  const ended = (outcome, basis) => accessRequestRow(ledgerEntry({
    outcome, basis, auditor: null, decision: null, llmRecommendation: null, llmAgreement: null,
  }));
  assert.deepEqual(ended('EXPIRED', 'REVIEW_DEADLINE').decision, {
    value: 'NONE', label: 'No decision', detail: 'the request expired',
  });
  assert.deepEqual(ended('CANCELLED', 'REQUESTER_CANCELLED').decision, {
    value: 'NONE', label: 'No decision', detail: 'cancelled by the requester',
  });
  assert.deepEqual(ended('EXPIRED', 'REVIEW_DEADLINE').llm, {
    value: 'NOT_RECORDED', label: 'Not recorded', detail: 'the request ended without a decision',
  });
});

test('never throws on an incomplete entry', () => {
  const row = accessRequestRow({ requestId: 'REQ-2' });
  assert.deepEqual(row.who, { name: '—', detail: null });
  assert.deepEqual(row.what, { name: '—', detail: null });
  assert.equal(row.decision.value, 'NONE');
});

test('orders the log by time without changing the list it was given', () => {
  const rows = ['2026-10-06T10:00:00.000Z', '2026-10-07T09:00:00.000Z', '2026-10-05T08:00:00.000Z']
    .map((decidedAtUtc, index) => accessRequestRow(ledgerEntry({ requestId: `REQ-${index}`, decidedAtUtc })));
  const ids = (list) => list.map((row) => row.requestId);
  assert.deepEqual(ids(sortAccessRows(rows, SORT.NEWEST)), ['REQ-1', 'REQ-0', 'REQ-2']);
  assert.deepEqual(ids(sortAccessRows(rows, SORT.OLDEST)), ['REQ-2', 'REQ-0', 'REQ-1']);
  assert.deepEqual(ids(rows), ['REQ-0', 'REQ-1', 'REQ-2']);
});

test('filters by requester or record text, by LLM recommendation and by auditor decision', () => {
  const rows = [
    ledgerEntry({ requestId: 'REQ-A' }),
    ledgerEntry({
      requestId: 'REQ-B', recordId: 'REC-CD-002', decision: 'FORCE_DENY',
      llmRecommendation: 'DENY', requester: { username: 'si.rao', organization: 'police', role: 'sub-inspector' },
    }),
    ledgerEntry({
      requestId: 'REQ-C', basis: 'DYNAMIC_AUTHORIZATION', decision: null, llmRecommendation: null,
      llmAgreement: null, auditor: null,
    }),
  ].map(accessRequestRow);
  const ids = (filters) => filterAccessRows(rows, { ...NO_FILTERS, ...filters }).map((row) => row.requestId);
  assert.deepEqual(ids({}), ['REQ-A', 'REQ-B', 'REQ-C']);
  assert.deepEqual(ids({ text: ' SI.RAO ' }), ['REQ-B']);
  assert.deepEqual(ids({ text: 'rec-fir' }), ['REQ-A', 'REQ-C']);
  assert.deepEqual(ids({ text: 'req-c' }), ['REQ-C']);
  assert.deepEqual(ids({ llm: 'DENY' }), ['REQ-B']);
  assert.deepEqual(ids({ llm: 'NOT_ASKED' }), ['REQ-C']);
  assert.deepEqual(ids({ decision: 'FORCE_ALLOW' }), ['REQ-A']);
  assert.deepEqual(ids({ decision: 'NONE' }), ['REQ-C']);
  assert.deepEqual(ids({ llm: 'ALLOW', decision: 'FORCE_DENY' }), []);
});

test('counts only the filters that are actually set', () => {
  assert.equal(activeFilterCount(NO_FILTERS), 0);
  assert.equal(activeFilterCount({ text: '   ', llm: '', decision: '' }), 0);
  assert.equal(activeFilterCount({ text: 'rao', llm: 'DENY', decision: '' }), 2);
});

test('formats a log time as a compact local timestamp', async () => {
  const { timestamp } = await import('../js/core/format.js');
  assert.equal(timestamp(new Date(2026, 9, 6, 9, 5, 3).toISOString()), '2026-10-06 09:05:03');
  assert.equal(timestamp(null), '—');
  assert.equal(timestamp('not a date'), 'not a date');
});
