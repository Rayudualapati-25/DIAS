'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Defaults reproduce the retained V4 analysis; every path is overridable so the
// same replay can be run for a later model generation without a second copy.
const DEFAULTS = Object.freeze({
  source: 'LLMxAI/experiments/runs/20260902_qwen3_policy_engine_eval_v4/proposed_full360.json',
  'subject-ablation': 'LLMxAI/experiments/runs/20260902_qwen3_policy_engine_eval_v4/subject_ablation.json',
  'dataset-audit': 'LLMxAI/experiments/runs/20260902_qwen3_policy_dataset_audit_v4/report.json',
  'run-dir': 'experiments/runs/20260903_core_llm_blockchain_workflow',
  'table-dir': 'results/tables/core-llm-blockchain-workflow',
  label: 'fine_tuned_v4',
});

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 2; index < argv.length; index += 2) {
    const name = String(argv[index] || '').replace(/^--/, '');
    if (!(name in args) || argv[index + 1] === undefined) {
      throw new Error(`invalid option '${argv[index] || ''}'; expected --<${Object.keys(args).join('|')}> <value>`);
    }
    args[name] = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv);
const sourcePath = path.resolve(root, args.source);
const subjectAblationPath = path.resolve(root, args['subject-ablation']);
const datasetAuditPath = path.resolve(root, args['dataset-audit']);
const runDir = path.resolve(root, args['run-dir']);
const tableDir = path.resolve(root, args['table-dir']);
const LABEL = args.label;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function score(rows, guardEnabled) {
  const totals = {
    n: rows.length,
    decisionCorrect: 0,
    jointCorrect: 0,
    falseAllowCount: 0,
    expectedNonAllowCount: 0,
    rejectedOutputCount: 0,
    routedToAudit: 0,
    routedByExpectedDecision: { allow: 0, deny: 0, escalate: 0 },
  };

  for (const row of rows) {
    // Output that fails the schema never reaches the ledger: the backend rejects it
    // and returns 503 without writing a decision, so it is neither an automatic
    // outcome nor an escalation. Counted separately rather than silently dropped.
    if (!row.prediction) {
      totals.rejectedOutputCount += 1;
      if (row.expected.decision !== 'allow') totals.expectedNonAllowCount += 1;
      continue;
    }
    const mismatch = row.prediction.decision !== row.expected.decision
      || row.prediction.reasonCode !== row.expected.reasonCode;
    let decision = row.prediction.decision;
    let reasonCode = row.prediction.reasonCode;

    if (guardEnabled && mismatch) {
      decision = 'escalate';
      reasonCode = 'MODEL_POLICY_DISAGREEMENT';
      totals.routedToAudit += 1;
      totals.routedByExpectedDecision[row.expected.decision] += 1;
    }

    if (decision === row.expected.decision) totals.decisionCorrect += 1;
    if (decision === row.expected.decision && reasonCode === row.expected.reasonCode) {
      totals.jointCorrect += 1;
    }
    if (row.expected.decision !== 'allow') {
      totals.expectedNonAllowCount += 1;
      if (decision === 'allow') totals.falseAllowCount += 1;
    }
  }

  return {
    ...totals,
    decisionAccuracy: totals.decisionCorrect / totals.n,
    jointDecisionReasonAccuracy: totals.jointCorrect / totals.n,
    falseAllowRateAmongNonAllow: totals.falseAllowCount / totals.expectedNonAllowCount,
  };
}

const source = readJson(sourcePath);
const subjectAblation = readJson(subjectAblationPath);
const datasetAudit = readJson(datasetAuditPath);
if (datasetAudit.checks?.oracleMismatches !== 0) {
  throw new Error('dataset oracle labels are not fully consistent with the policy evaluator');
}

const result = {
  createdAtUtc: new Date().toISOString(),
  method: 'Post-hoc replay of retained V4 predictions against policy-oracle labels',
  interpretation: 'The guard changes mismatched model outputs to ESCALATE; it does not retrain the model.',
  source: {
    predictionArtifact: path.relative(root, sourcePath),
    predictionArtifactSha256: sha256(sourcePath),
    datasetAuditArtifact: path.relative(root, datasetAuditPath),
    datasetAuditArtifactSha256: sha256(datasetAuditPath),
    oracleMismatches: datasetAudit.checks.oracleMismatches,
    seed: source.config.seed,
    adapterSha256: source.modelInfo.adapterSha256,
  },
  baselineGuardOff: score(source.rows, false),
  proposedGuardOn: score(source.rows, true),
  subjectAttributeAblation: {
    sourceArtifact: path.relative(root, subjectAblationPath),
    sourceArtifactSha256: sha256(subjectAblationPath),
    n: subjectAblation.metrics.n,
    decisionAccuracy: subjectAblation.metrics.decisionAccuracy,
    jointDecisionReasonAccuracy: subjectAblation.metrics.jointDecisionReasonAccuracy,
    falseAllowRateAmongNonAllow: subjectAblation.metrics.falseAllowRateAmongNonAllow,
  },
};

fs.mkdirSync(runDir, { recursive: true });
fs.mkdirSync(tableDir, { recursive: true });
fs.writeFileSync(
  path.join(runDir, 'guard-ablation.json'),
  `${JSON.stringify(result, null, 2)}\n`
);

const csv = [
  'arm,n,decision_accuracy,joint_decision_reason_accuracy,false_allow_count,expected_non_allow_count,false_allow_rate,routed_to_audit',
  `${LABEL}_guard_off,${result.baselineGuardOff.n},${result.baselineGuardOff.decisionAccuracy},${result.baselineGuardOff.jointDecisionReasonAccuracy},${result.baselineGuardOff.falseAllowCount},${result.baselineGuardOff.expectedNonAllowCount},${result.baselineGuardOff.falseAllowRateAmongNonAllow},${result.baselineGuardOff.routedToAudit}`,
  `${LABEL}_guard_on,${result.proposedGuardOn.n},${result.proposedGuardOn.decisionAccuracy},${result.proposedGuardOn.jointDecisionReasonAccuracy},${result.proposedGuardOn.falseAllowCount},${result.proposedGuardOn.expectedNonAllowCount},${result.proposedGuardOn.falseAllowRateAmongNonAllow},${result.proposedGuardOn.routedToAudit}`,
  `${LABEL}_no_subject_attributes,${result.subjectAttributeAblation.n},${result.subjectAttributeAblation.decisionAccuracy},${result.subjectAttributeAblation.jointDecisionReasonAccuracy},,,${result.subjectAttributeAblation.falseAllowRateAmongNonAllow},`,
].join('\n');
fs.writeFileSync(path.join(tableDir, 'guard-ablation.csv'), `${csv}\n`);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
