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

