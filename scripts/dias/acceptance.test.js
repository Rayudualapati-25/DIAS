'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ledgerLeaks } = require('./ledger-privacy');
const { backendRecommendation } = require('./acceptance-scenarios');
const { ledgerOnly } = require('./acceptance-client');

test('privacy checks separate backend verification from committed ledger fields', () => {
  const trail = { request: { justificationHash: 'a'.repeat(64) },
    offChainReview: { justification: 'private' },
    offChainVerification: { justification: { status: 'verified' } } };
  assert.deepEqual(ledgerLeaks(ledgerOnly(trail)), []);
  assert.deepEqual(ledgerLeaks(ledgerOnly({ ...trail, request: { justification: 'leaked' } })),
    ['request.justification']);
});

test('v3 hashes and committed recommendation values are allowed; plaintext explanation is rejected', () => {
  const ledger = { request: { justificationHash: 'a'.repeat(64) },
    recommendationCommitment: { recommendation: 'DENY', recommendationHash: 'b'.repeat(64), signature: 'signed' },
    decision: { llmRecommendation: 'DENY', noteHash: 'c'.repeat(64) } };
  assert.deepEqual(ledgerLeaks(ledger), []);
  assert.deepEqual(ledgerLeaks({ ...ledger, nested: { reason: 'private', justification: 'private' } }),
    ['nested.reason', 'nested.justification']);
});

test('acceptance expects the v3 commitment lifecycle and verifies the off-chain object', async () => {
  const client = {
    readyReview: async () => ({ recommendationState: 'committed', justification: 'off-chain',
      recommendation: { generationStatus: 'OK', recommendation: 'DENY' },
      commitment: { recommendation: 'DENY' }, integrity: { status: 'verified' } }),
    trail: async () => ({ data: { lifecycle: ['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED',
      'RECOMMENDATION_COMMITTED'].map(eventType => ({ eventType })), request: { justificationHash: 'a'.repeat(64) },
      recommendationCommitment: { recommendation: 'DENY', recommendationHash: 'b'.repeat(64) },
      offChainReview: { recommendation: { reason: 'off-chain' } } } }),
  };
  const { result } = await backendRecommendation(client, 'REQ-1');
  assert.equal(result.status, 'PASS', JSON.stringify(result.checks));
});
