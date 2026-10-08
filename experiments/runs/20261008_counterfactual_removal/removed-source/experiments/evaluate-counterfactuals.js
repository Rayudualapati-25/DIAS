'use strict';

/** Deterministic engineering comparison, not model-accuracy or legal evidence. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { loadBundle } = require('../policies/lib/bundle');
const { evaluateReference } = require('../policies/reference-oracle/referencePolicyOracle');
const { verifiedRequestFixture } = require('../backend/test/fixtures/diasFixtures');
const {
  applyChanges, candidateChanges, changeSetsFrom, counterfactualsFor,
} = require('../backend/src/dias/counterfactuals');

const out = path.resolve(process.argv[2] || 'experiments/runs/20261008_counterfactuals/offline');
if (fs.existsSync(out)) throw new Error('Output exists; choose a new directory to retain earlier evidence');
fs.mkdirSync(out, { recursive: true });
const { bundle, bundleHash } = loadBundle();
const config = {
  seed: 0, randomness: 'none', bundleHash, maxChanges: 2,
  roles: [
    ['inspector', 'police', 'PoliceMSP', 'fir'], ['constable', 'police', 'PoliceMSP', 'fir'],
    ['lab-analyst', 'forensics', 'ForensicsMSP', 'forensic-report'], ['judge', 'court', 'CourtMSP', 'court-order'],
  ],
  assigned: [true, false], credential: ['active', 'revoked'], sameDistrict: [true, false],
  clearance: ['low', 'high'], sensitivity: ['low', 'high'], flags: [false, true],
  actions: ['view', 'export'], purposes: ['investigation', 'undefined-purpose'],
  baseline: 'all unverified one-fact suggestions',
  verificationAblation: 'unfiltered one/two-fact candidate universe; not a runtime mode',
  authorityAblation: 'remove authority labels from the verified outputs',
};
fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
const names = ['baseline_unverified_single', 'verified_two_facts', 'ablation_single_fact',
  'ablation_no_verification', 'ablation_no_authority', 'ablation_disabled'];
const metrics = Object.fromEntries(names.map((name) => [name, {
  variant: name, totalCases: 0, deniedCases: 0, coveredDeniedCases: 0, emittedSets: 0,
  verifiedAllowSets: 0, minimalSets: 0, changes: 0, authorityLabelledChanges: 0,
}]));
const records = [];
let id = 0;
for (const [role, organization, mspId, recordType] of config.roles)
for (const assigned of config.assigned) for (const credentialStatus of config.credential)
for (const sameDistrict of config.sameDistrict) for (const clearance of config.clearance)
for (const sensitivityLevel of config.sensitivity)
for (const sealed of config.flags) for (const juvenileFlag of config.flags) for (const victimProtectionFlag of config.flags)
for (const action of config.actions) for (const purpose of config.purposes) {
  const input = verifiedRequestFixture({
    requester: { role, organization, mspId, assignedToRequestedCase: assigned, credentialStatus,
      clearance, jurisdiction: sameDistrict ? 'district-north' : 'district-south' },
    resource: { recordType, sensitivityLevel, sealed, juvenileFlag, victimProtectionFlag },
    request: { action, purpose },
  });
  const before = JSON.stringify(input);
  const original = evaluateReference(bundle, input);
  const full = counterfactualsFor({ verifiedRequest: input, bundle });
  assert.ok(full, 'every grid input must be supported');
  const candidates = original.recommendation === 'DENY' ? candidateChanges(input, bundle) : [];
  const variants = {
    baseline_unverified_single: changeSetsFrom(candidates, 1),
    verified_two_facts: full.changeSets.map((set) => set.changes),
    ablation_single_fact: counterfactualsFor({ verifiedRequest: input, bundle, maxChanges: 1 }).changeSets.map((set) => set.changes),
    ablation_no_verification: changeSetsFrom(candidates, 2),
    ablation_no_authority: full.changeSets.map((set) => set.changes.map(({ authority, ...change }) => change)),
    ablation_disabled: [],
  };
  const counts = {};
  for (const [name, sets] of Object.entries(variants)) {
    const m = metrics[name]; m.totalCases += 1;
    if (original.recommendation === 'DENY') m.deniedCases += 1;
    let covered = false;
    const count = { emitted: sets.length, verified: 0, minimal: 0 };
    for (const changes of sets) {
      const allowed = evaluateReference(bundle, applyChanges(input, changes)).recommendation === 'ALLOW';
      const minimal = allowed && changes.every((_, index) => evaluateReference(bundle,
        applyChanges(input, changes.filter((_, i) => i !== index))).recommendation === 'DENY');
      m.emittedSets += 1; m.verifiedAllowSets += Number(allowed); m.minimalSets += Number(minimal);
      count.verified += Number(allowed); count.minimal += Number(minimal); covered ||= allowed;
      m.changes += changes.length;
      m.authorityLabelledChanges += changes.filter((c) => ['REQUESTER', 'ADMINISTRATIVE', 'LEGAL'].includes(c.authority)).length;
      if (name === 'verified_two_facts') { assert.equal(allowed, true); assert.equal(minimal, true); }
    }
    if (covered && original.recommendation === 'DENY') m.coveredDeniedCases += 1;
    counts[name] = count;
  }
  assert.equal(JSON.stringify(input), before, 'input mutated');
  records.push({ id: ++id, input, original, verifiedChangeSets: full.changeSets, unresolvedClauses: full.unresolvedClauses, counts });
}
const rows = Object.values(metrics).map((m) => ({
  ...m, fidelity: m.emittedSets ? m.verifiedAllowSets / m.emittedSets : null,
  coverage: m.deniedCases ? m.coveredDeniedCases / m.deniedCases : null,
  minimality: m.emittedSets ? m.minimalSets / m.emittedSets : null,
  authorityCoverage: m.changes ? m.authorityLabelledChanges / m.changes : null,
}));
fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify(records) + '\n');
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify({ completedAt: new Date().toISOString(), rows,
  limitations: ['Synthetic exhaustive grid, not legal feasibility or explanation quality.',
    'Fidelity is against the same reference oracle used to filter outputs; it tests consistency, not independent policy correctness.',
    'Coverage is bounded by the permitted facts and two-change search.', 'No LLM, Fabric writes or testbed measurements in this experiment.'] }, null, 2) + '\n');
const fields = Object.keys(rows[0]);
fs.writeFileSync(path.join(out, 'comparison.csv'), fields.join(',') + '\n' + rows.map((r) => fields.map((f) => r[f] ?? '').join(',')).join('\n') + '\n');
console.log(JSON.stringify({ cases: id, rows }, null, 2));
