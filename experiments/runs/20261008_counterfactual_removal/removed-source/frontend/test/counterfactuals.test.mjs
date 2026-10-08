import test from 'node:test';
import assert from 'node:assert/strict';
import { counterfactualView } from '../js/shared/counterfactuals.js';

const denied = (counterfactuals, overrides = {}) => ({
  viewer: 'requester', explanationVisible: true, decision: { decision: 'FORCE_DENY' },
  counterfactuals, ...overrides,
});
const result = (changes = []) => ({ available: true, writtenPolicy: { result: 'DENY', blockingClauses: ['GP-ASSIGN:C1@v1'] },
  changeSets: changes, unresolvedClauses: [], maxChanges: 2 });

test('names who may change a fact and describes the written policy, without promising a grant', () => {
  const view = counterfactualView(denied(result([{ changes: [
    { description: 'the officer is assigned to the requested case', authority: 'ADMINISTRATIVE' },
    { description: 'the court unseals the record', authority: 'LEGAL' },
  ] }])));
  assert.deepEqual(view.alternatives, [[
    'the officer is assigned to the requested case — responsible administrator',
    'the court unseals the record — legal authority',
  ]]);
  assert.match(view.message, /hypothetical/);
  assert.match(view.notice, /auditor/);
  assert.doesNotMatch(view.message, /will be granted/);
});

test('does not infer why an auditor denied a request the written policy permits', () => {
  const view = counterfactualView(denied({ ...result(), writtenPolicy: { result: 'ALLOW', blockingClauses: [] } }));
  assert.match(view.message, /cannot explain the auditor's denial/);
  assert.deepEqual(view.alternatives, []);
});

test('reports the two-fact search limit without claiming no possible solution exists', () => {
  const view = counterfactualView(denied({ ...result(), unresolvedClauses: ['GP-JURIS:C1@v1'] }));
  assert.match(view.message, /within the two-fact limit/);
  assert.deepEqual(view.alternatives, []);
});

test('hides hints for allowed, waiting, disabled and unrelated viewers, including an auditor requesting their own record', () => {
  for (const detail of [null, denied(null), denied(result(), { explanationVisible: false }),
    denied(result(), { decision: null }), denied(result(), { decision: { decision: 'FORCE_ALLOW' } }),
    denied(result(), { viewer: 'reviewer' })]) assert.equal(counterfactualView(detail), null);
});

test('supports auditors reviewing somebody else and treats missing facts as unavailable', () => {
  const audit = counterfactualView(denied(result(), { viewer: 'auditor', decision: null }));
  assert.ok(audit);
  const missing = counterfactualView(denied({ available: false, reason: 'context-mismatch' }));
  assert.match(missing.message, /unavailable/);
  assert.deepEqual(missing.alternatives, []);
});
