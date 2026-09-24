'use strict';

const assert = require('assert');
const {
  MUTATIONS, makeDataset, runVariant,
} = require('./run-workflow-comparison');

const dataset = makeDataset();
assert.strictEqual(dataset.requests.length, 1 + 5 + MUTATIONS.length);
assert.strictEqual(
  new Set(dataset.requests.map((request) => request.scenarioId)).size,
  dataset.requests.length
);
const seed = dataset.requests[0];
for (const request of dataset.requests.filter((item) => item.kind === 'exact-repeat')) {
  assert.strictEqual(request.fingerprintHash, seed.fingerprintHash);
}
for (const request of dataset.requests.filter((item) => item.kind === 'one-field-near-miss')) {
  assert.notStrictEqual(request.fingerprintHash, seed.fingerprintHash);
}

const proposed = runVariant(dataset, {
  variant: 'proposed', ruleCreationEnabled: true, lookupEnabled: true,
});
assert.strictEqual(proposed.metrics.ruleCreations, 1);
assert.strictEqual(proposed.metrics.correctAutomaticGrants, 5);
assert.strictEqual(proposed.metrics.falseAutomaticGrants, 0);
assert.strictEqual(proposed.metrics.llmInvocations, 1 + MUTATIONS.length);

for (const [dimension] of MUTATIONS) {
  const ablation = runVariant(dataset, {
    variant: `omit-${dimension}`,
    ruleCreationEnabled: true,
    lookupEnabled: true,
    omittedDimension: dimension,
  });
  assert.strictEqual(ablation.metrics.falseAutomaticGrants, 1, dimension);
}

process.stdout.write(`DIAS workflow replay assertions passed (${dataset.requests.length} scenarios).\n`);
