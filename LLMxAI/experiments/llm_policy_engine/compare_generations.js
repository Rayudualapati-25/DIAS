'use strict';

/**
 * Side-by-side metrics and rule-order behaviour for two or more model generations.
 *
 *   node compare_generations.js LABEL=run.json [LABEL=run.json ...]
 *
 * The runtime safety-guard replay (auto-decided vs routed to AuditMSP, and unsafe
 * allows surviving the guard) has one authoritative implementation elsewhere:
 * experiments/analyze-llm-safety-guard.js. Do not duplicate it here.
 */

const fs = require('fs');
const path = require('path');

const RULE_ORDER = Object.freeze({
  CRED_NOT_ACTIVE: 1, INVALID_PURPOSE: 2, RBAC_NO_PERMISSION: 3, AUDIT_METADATA_ONLY: 4,
  SEALED_RECORD: 5, JUVENILE_PROTECTED: 6, VICTIM_DATA_NOT_NECESSARY: 7,
  EMERGENCY_CROSS_JURISDICTION: 8, CROSS_JURISDICTION: 8, NOT_ASSIGNED: 9,
  INSUFFICIENT_CLEARANCE: 10, POLICY_SATISFIED: 11,
});

const pct = (value) => (value === null || value === undefined ? '—' : `${(100 * value).toFixed(2)}%`);

function ruleOrderErrors(rows) {
  let early = 0;
  let late = 0;
  for (const row of rows) {
    const expected = RULE_ORDER[row.expected.reasonCode];
    const predicted = RULE_ORDER[(row.classification || {}).reasonCode];
    if (!predicted || !expected) continue;
    if (predicted < expected) early += 1;
    else if (predicted > expected) late += 1;
  }
  return { firedTooEarly: early, missedFirstFiring: late };
}

const entries = process.argv.slice(2).map((argument) => {
  const [label, file] = argument.split('=', 2);
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { label, file, report };
});

console.log('| Arm | n | Decision | Joint | False allow | Adversarial joint | Median latency |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const { label, report } of entries) {
  const m = report.metrics;
  console.log(`| ${label} | ${m.n} | ${pct(m.decisionAccuracy)} | ${pct(m.jointDecisionReasonAccuracy)} | `
    + `${m.falseAllowCount}/${m.expectedNonAllowCount} (${pct(m.falseAllowRateAmongNonAllow)}) | `
    + `${pct(m.adversarialJointAccuracy)} | ${m.latencyMs.median.toFixed(0)} ms |`);
}

console.log('\nRule-order behaviour:');
for (const { label, report } of entries) {
  const o = ruleOrderErrors(report.rows);
  console.log(`  ${label}: fired-too-early ${o.firedTooEarly}, missed-first-firing ${o.missedFirstFiring}`);
}

console.log('\nSources:');
for (const { label, file, report } of entries) {
  console.log(`  ${label}: ${path.basename(file)} adapter=${report.modelInfo?.adapterSha256?.slice(0, 12) || '—'} data=${report.config.data}`);
}
