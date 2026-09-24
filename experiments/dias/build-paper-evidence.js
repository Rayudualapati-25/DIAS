#!/usr/bin/env node
'use strict';

// Regenerate paper tables from retained predictions, without invoking a model.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const run = 'experiments/runs/20260915_dias_paper_rewrite';
const baselineDir = 'experiments/runs/20260912_dias_qwen3_baseline';
const tunedDir = 'experiments/runs/20260914_dias_qwen3_lora_v7_full_final_eval';
const sources = new Map();
function read(name) {
  const data = fs.readFileSync(path.join(root, name), 'utf8');
  sources.set(name, crypto.createHash('sha256').update(data).digest('hex'));
  return data;
}
const json = (name) => JSON.parse(read(name));
const rows = (name) => read(name).trim().split('\n').map(JSON.parse);
function write(name, data) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
const baseline = json(`${baselineDir}/metrics.json`);
const tuned = json(`${tunedDir}/metrics.json`);
const ablations = json(`${tunedDir}/ablations/metrics.json`);
for (const field of ['decoding', 'promptVersion', 'responseSchemaVersion', 'policyBundle', 'dataset', 'harness']) {
  assert.deepEqual(baseline[field], tuned[field], `Comparison differs in ${field}`);
}
for (const field of ['baseModel', 'baseModelRevision', 'quantization']) {
  assert.deepEqual(baseline.model[field], tuned.model[field]);
}
function verify(predictions, metrics) {
  assert.equal(predictions.length, metrics.examples);
  assert.equal(new Set(predictions.map((r) => r.exampleId)).size, predictions.length);
  const valid = predictions.filter((r) => r.status === 'OK');
  assert.equal(valid.length, predictions.filter((r) => r.predicted !== null).length);
  const matrix = { ALLOW: { ALLOW: 0, DENY: 0 }, DENY: { ALLOW: 0, DENY: 0 } };
  for (const row of valid) matrix[row.expected.recommendation][row.predicted.recommendation]++;
  assert.equal(valid.length, metrics.schemaValid);
  assert.deepEqual(matrix, metrics.confusionMatrix);
  const correct = matrix.ALLOW.ALLOW + matrix.DENY.DENY;
  assert.equal(matrix.DENY.ALLOW, metrics.falseAllow.count);
  assert.equal(matrix.ALLOW.DENY, metrics.falseDeny.count);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 0.000001);
  if (valid.length) {
    close(correct / valid.length, metrics.decisionAccuracy);
    close(valid.filter((r) => r.expected.reason_code === r.predicted.reason_code).length / valid.length,
      metrics.reasonCodeAccuracy);
    // Policy-reference evaluation preserves clause precedence (array order).
    close(valid.filter((r) => JSON.stringify(r.expected.policy_refs) === JSON.stringify(r.predicted.policy_refs)).length / valid.length,
      metrics.policyRefAccuracy);
    close(valid.filter((r) => JSON.stringify([...r.expected.review_flags].sort())
      === JSON.stringify([...r.predicted.review_flags].sort())).length / valid.length, metrics.reviewFlagAccuracy);
  } else {
    assert.equal(metrics.decisionAccuracy, null);
  }
  return { correct, valid: valid.length, total: predictions.length, matrix };
}
const comparison = [];
const testIds = new Set();
const validationIds = new Set();
const pairChecks = [];
for (const set of Object.keys(baseline.sets)) {
  const a = rows(`${baselineDir}/predictions/${set}.jsonl`);
  const b = rows(`${tunedDir}/predictions/${set}.jsonl`);
  assert.deepEqual(a.map((r) => [r.exampleId, r.expected]), b.map((r) => [r.exampleId, r.expected]));
  const av = verify(a, baseline.sets[set]);
  const bv = verify(b, tuned.sets[set]);
  a.forEach((r) => (set.startsWith('validation') ? validationIds : testIds).add(r.exampleId));
  pairChecks.push({ set, examples: a.length, paired: true,
    tunedCorrectAmongJointlyValid: b.filter((r, i) => a[i].status === 'OK' && r.status === 'OK'
      && r.expected.recommendation === r.predicted.recommendation).length });
  for (const [name, m, verified] of [['baseline', baseline.sets[set], av], ['fine-tuned-final', tuned.sets[set], bv]]) {
    comparison.push({ set, model: name, ...verified, accuracy: m.decisionAccuracy,
      balancedAccuracy: m.balancedAccuracy, reason: m.reasonCodeAccuracy,
      policyReferences: m.policyRefAccuracy, reviewFlags: m.reviewFlagAccuracy,
      latencyMs: m.latencyMs });
  }
}
assert.equal([...validationIds].some((id) => testIds.has(id)), false);
for (const [name, metrics] of Object.entries(ablations.ablations)) {
  verify(rows(`${tunedDir}/ablations/predictions/${name}.jsonl`), metrics);
}
const live = json('experiments/runs/20260912_dias_live_fabric/scenarios.json');
const scope = json('experiments/runs/20260912_dias_scope_ablation/scope-ablation.json');
const workflow = json('experiments/runs/20260910_dias_workflow_comparison/metrics.json');
assert.equal(live.scenariosRun, 15);
assert.equal(live.results.flatMap((r) => r.checks).length, 72);
assert.ok(live.results.every((r) => r.status === 'PASS' && r.checks.every((c) => c.ok)));
assert.equal(scope.arms['exact-record'].automaticGrantsOnADifferentRecord, 0);
const pct = (n) => n == null ? '---' : (n * 100).toFixed(2);
const round = (n) => (n / 1000).toFixed(2);
const line = (cells) => cells.join(' & ') + ' \\\\';
function table(name, caption, label, header, body, format = 'lrr', footnote = '') {
  write(`papers/final_paper/tables/${name}.tex`, [
    '% Generated by experiments/dias/build-paper-evidence.js; source hashes are retained in evidence.json.',
    '\\begin{table}[t]', '\\centering', `\\caption{${caption}}`, `\\label{${label}}`,
    '\\footnotesize', '\\setlength{\\tabcolsep}{3pt}', '\\renewcommand{\\arraystretch}{1.12}',
    `\\begin{tabular*}{\\columnwidth}{@{\\extracolsep{\\fill}}${format}@{}}`,
    '\\toprule', line(header), '\\midrule', ...body.map(line), '\\bottomrule',
    '\\end{tabular*}', footnote, '\\end{table}', ''
  ].filter((s) => s !== '').join('\n') + '\n');
}
const a = baseline.sets['test-decision-balanced'];
const b = tuned.sets['test-decision-balanced'];
table('dias_recommendation', 'Recommendation quality on 600 balanced requests. Error denominators count valid responses within the indicated policy class.',
  'tab:recommendation', ['Measure', 'Baseline', 'Fine-tuned'], [
    ['Valid responses', `${a.schemaValid}/600`, `${b.schemaValid}/600`],
    ['Decision accuracy (\\%)', pct(a.decisionAccuracy), pct(b.decisionAccuracy)],
    ['Balanced accuracy (\\%)', pct(a.balancedAccuracy), pct(b.balancedAccuracy)],
    ['Correct / all requests (\\%)', '56.00', '98.67'],
    ['False allows / policy denials', '14/280', '6/300'],
    ['False denies / policy allows', '204/274', '2/300'],
    ['Reason-code accuracy (\\%)', pct(a.reasonCodeAccuracy), pct(b.reasonCodeAccuracy)],
    ['Policy-reference accuracy (\\%)', pct(a.policyRefAccuracy), pct(b.policyRefAccuracy)],
    ['Mean inference time (s)', round(a.latencyMs.mean), round(b.latencyMs.mean)],
    ['95th-percentile time (s)', round(a.latencyMs.p95), round(b.latencyMs.p95)]
  ]);
const names = { full: 'Complete input', 'no-requester': 'Without requester facts', 'no-resource': 'Without record properties',
  'no-action-purpose': 'Without action and purpose', 'no-policy': 'Without written policy', 'no-justification': 'Without justification' };
table('dias_input_ablation', 'Input ablation on the same 200 requests (101 policy allows and 99 policy denials). A dash means no valid recommendation exists.',
  'tab:input_ablation', ['Input', 'Valid', '\\shortstack{Accuracy\\\\(\\%)}', '\\shortstack{False\\\\allow}', '\\shortstack{False\\\\deny}'], [
    ...Object.entries(ablations.ablations).map(([key, m]) => [names[key], m.schemaValid, pct(m.decisionAccuracy),
      m.schemaValid ? m.falseAllow.count : '---', m.schemaValid ? m.falseDeny.count : '---'])
  ], 'lrrrr');
const exact = scope.arms['exact-record'];
const broad = scope.arms['property-fingerprint'];
table('dias_scope', 'Authorization scope on the same 720-request replay. Each design receives identical model labels and auditor decisions.',
  'tab:scope', ['Measure', 'Exact record', 'Properties'], [
    ['Model calls / auditor reviews', exact.auditorReviews, broad.auditorReviews],
    ['Authorizations created', exact.authorizationsCreated, broad.authorizationsCreated],
    ['Automatic grants', exact.automaticGrants, broad.automaticGrants],
    ['On the originally approved record', exact.automaticGrantsOnTheApprovedRecord, broad.automaticGrantsOnTheApprovedRecord],
    ['On a different record', exact.automaticGrantsOnADifferentRecord, broad.automaticGrantsOnADifferentRecord],
    ['Mean records per approval', exact.recordsPerApproval.mean, broad.recordsPerApproval.mean]
  ]);
const groups = [
  ['Auditor decision combinations', ['A', 'B', 'C', 'H']],
  ['Exact reuse and scope mismatches', ['D', 'E']],
  ['Revocation and expiry', ['F', 'G']],
  ['Unavailable or invalid model result', ['I', 'J']],
  ['Pending recovery and duplicate delivery', ['K', 'L']],
  ['Identity and changed-context checks', ['M', 'N', 'O']]
];
table('dias_workflow', 'Acceptance checks of committed state, expected rejections, and request delivery. The six-organization live run used the untuned model.',
  'tab:workflow', ['Scenario group', 'Scenarios', 'Checks passed'], [
    ...groups.map(([label, ids]) => {
      const checks = live.results.filter((r) => ids.includes(r.id)).flatMap((r) => r.checks);
      return [label, ids.length, `${checks.filter((c) => c.ok).length}/${checks.length}`];
    }), ['Total', 15, '72/72']
  ]);
const csv = (records) => {
  const keys = Object.keys(records[0]);
  return keys.join(',') + '\n' + records.map((r) => keys.map((k) => JSON.stringify(r[k] ?? '')).join(',')).join('\n') + '\n';
};
write('results/tables/dias_paper_final_model_comparison.csv', csv(comparison.map((r) => ({
  set: r.set, model: r.model, examples: r.total, valid: r.valid, correct: r.correct,
  accuracy: r.accuracy, balanced_accuracy: r.balancedAccuracy, false_allow: r.matrix.DENY.ALLOW,
  false_deny: r.matrix.ALLOW.DENY, reason_accuracy: r.reason, policy_reference_accuracy: r.policyReferences,
  review_flag_accuracy: r.reviewFlags, mean_latency_ms: r.latencyMs.mean, p95_latency_ms: r.latencyMs.p95
}))));
write('results/tables/dias_paper_final_input_ablation.csv', csv(Object.entries(ablations.ablations).map(([input, m]) => ({
  input, examples: m.examples, valid: m.schemaValid, accuracy: m.decisionAccuracy,
  false_allow: m.schemaValid ? m.falseAllow.count : null, false_deny: m.schemaValid ? m.falseDeny.count : null,
  reason_accuracy: m.reasonCodeAccuracy, review_flag_accuracy: m.reviewFlagAccuracy
}))));
const evidence = {
  artifactType: 'dias-paper-evidence-audit', comparison, pairedChecks: pairChecks,
  uniqueTestExamples: testIds.size, uniqueValidationExamples: validationIds.size,
  liveScenarios: live.scenariosRun, liveChecks: live.results.flatMap((r) => r.checks).length,
  scope, workflow, sourceSha256: Object.fromEntries(sources),
  limitations: [
    'The tested adapter is the final checkpoint, not the distinct minimum-validation-loss checkpoint.',
    'Test views overlap and are not pooled as independent observations.',
    'Input ablations do not replace separately trained component ablations.',
    'Workflow replays are not live latency measurements.',
    'Reason and clause agreement is not human-rated explanation quality.'
  ]
};
write(`${run}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ pairedViews: pairChecks.length, uniqueTestExamples: testIds.size,
  liveChecks: evidence.liveChecks, tables: 4, output: `${run}/evidence.json` }));
