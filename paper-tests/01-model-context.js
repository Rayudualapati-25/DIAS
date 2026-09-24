'use strict';

/**
 * EXPERIMENT 01 — authorization model effectiveness and trusted-subject context.
 *
 * RQ1: how accurately does the fine-tuned model perform SEAL authorization, and
 *      how much does the authenticated subject context contribute?
 *
 * Every metric here is recomputed from the per-case rows of the retained
 * evaluation runs, not read from their stored summaries. The recomputation is
 * compared against each file's own summary and the difference is reported, so a
 * hand-edited summary cannot pass unnoticed.
 *
 * This experiment deliberately reports NOTHING about the deterministic
 * validator. The retained runs replay a guard derived from the model's own
 * action and purpose, and their dataset carries no committed action/purpose, so
 * those columns describe the pre-hardening validator and cannot support any
 * claim about the deployed two-condition guard. Experiment 02 owns that claim.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  REPO, metadata, stats, round, ratio, writeJson, writeCsv, banner,
} = require('./common');

const RUNS = path.join(REPO, 'experiments/runs/20260906_seal_precision_e2e');
const DATA = path.join(REPO, 'experiments/policy-v2-precision/data');

/**
 * The retained runs. `arm` is the prompt configuration the harness used:
 *   grounded    full system prompt: ordered policy rules, the RBAC row for the
 *               authenticated role, exemption lists, clearance ordering
 *   short       the base instruction only, without the injected policy
 *   no-subject  grounded prompt, but every authenticated subject attribute
 *               value replaced with null (record context left intact)
 */
const RUN_FILES = [
  { file: 'proposed_grounded_v6_best.json', label: 'V6 grounded', split: 'test' },
  { file: 'proposed_grounded_v4.json', label: 'V4 grounded', split: 'test' },
  { file: 'baseline_short_v4.json', label: 'V4 short prompt', split: 'test' },
  { file: 'ablation_full_trusted_subject_v6_best.json', label: 'V6 with subject context', split: 'validation' },
  { file: 'ablation_no_trusted_subject_v6_best.json', label: 'V6 without subject context', split: 'validation' },
];

const DECISIONS = ['allow', 'deny', 'escalate'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Joint accuracy keeps SEAL's definition: action AND purpose AND decision AND reason. */
const isJointCorrect = (r) => r.valid
  && r.prediction.action === r.expected.action
  && r.prediction.purpose === r.expected.purpose
  && r.prediction.decision === r.expected.decision
  && r.prediction.reasonCode === r.expected.reasonCode;

/** Precision, recall and F1 for one decision class, one-vs-rest. */
function classMetrics(rows, label) {
  const tp = rows.filter((r) => r.valid && r.prediction.decision === label && r.expected.decision === label).length;
  const fp = rows.filter((r) => r.valid && r.prediction.decision === label && r.expected.decision !== label).length;
  const fn = rows.filter((r) => r.expected.decision === label && !(r.valid && r.prediction.decision === label)).length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : null;
  return {
    support: rows.filter((r) => r.expected.decision === label).length,
    tp, fp, fn,
    precision: precision === null ? null : ratio(precision),
    recall: recall === null ? null : ratio(recall),
    f1: f1 === null ? null : ratio(f1),
  };
}

/**
 * Rows whose schema was rejected have no prediction. They are counted as
 * incorrect everywhere and given their own confusion-matrix column, because
 * "produced nothing usable" is a different failure from "predicted wrongly".
 */
function confusionMatrix(rows) {
  const matrix = {};
  DECISIONS.forEach((truth) => {
    matrix[truth] = { ...Object.fromEntries(DECISIONS.map((p) => [p, 0])), invalid: 0 };
  });
  rows.forEach((r) => {
    const truth = r.expected.decision;
    const predicted = r.valid ? r.prediction.decision : 'invalid';
    if (matrix[truth] && predicted in matrix[truth]) matrix[truth][predicted] += 1;
  });
  return matrix;
}

function score(rows) {
  const n = rows.length;
  const valid = rows.filter((r) => r.valid);
  const acc = (fn) => ratio(rows.filter((r) => r.valid && fn(r)).length / n);

  const nonAllowTruth = rows.filter((r) => r.expected.decision !== 'allow');
  const allowTruth = rows.filter((r) => r.expected.decision === 'allow');
  const falseAllows = nonAllowTruth.filter((r) => r.valid && r.prediction.decision === 'allow');
  const falseDenies = rows.filter((r) => r.valid
    && r.prediction.decision === 'deny' && r.expected.decision !== 'deny');

  const perClass = Object.fromEntries(DECISIONS.map((d) => [d, classMetrics(rows, d)]));
  const macroF1 = ratio(
    DECISIONS.map((d) => perClass[d].f1).filter((x) => x !== null)
      .reduce((a, b, _, arr) => a + b / arr.length, 0)
  );

  return {
    n,
    schemaValid: valid.length,
    schemaRejected: n - valid.length,
    decisionAccuracy: acc((r) => r.prediction.decision === r.expected.decision),
    jointAccuracy: ratio(rows.filter(isJointCorrect).length / n),
    actionAccuracy: acc((r) => r.prediction.action === r.expected.action),
    purposeAccuracy: acc((r) => r.prediction.purpose === r.expected.purpose),
    reasonAccuracy: acc((r) => r.prediction.reasonCode === r.expected.reasonCode),
    adversarialJointAccuracy: (() => {
      const adv = rows.filter((r) => r.adversarial);
      return adv.length ? ratio(adv.filter(isJointCorrect).length / adv.length) : null;
    })(),
    perClass,
    macroF1,
    confusionMatrix: confusionMatrix(rows),
    falseAllowCount: falseAllows.length,
    nonAllowGroundTruth: nonAllowTruth.length,
    falseAllowCases: falseAllows.map((r) => ({
      id: r.id, expected: r.expected.reasonCode, predicted: r.prediction.reasonCode,
    })),
    falseDenyCount: falseDenies.length,
    falseDenyCases: falseDenies.map((r) => ({
      id: r.id, expectedDecision: r.expected.decision, expectedReason: r.expected.reasonCode,
    })),
    allowGroundTruth: allowTruth.length,
    inferenceLatencyMs: stats(rows.map((r) => r.latencyMs)),
  };
}

/** Compare a recomputed figure with the number stored in the run file. */
function crossCheck(recomputed, stored) {
  const pairs = [
    ['decisionAccuracy', 'decisionAccuracy'],
    ['jointAccuracy', 'jointAccuracy'],
    ['actionAccuracy', 'actionAccuracy'],
    ['purposeAccuracy', 'purposeAccuracy'],
    ['falseAllowCount', 'falseAllows'],
    ['schemaValid', 'schemaValid'],
  ];
  const diffs = [];
  pairs.forEach(([mine, theirs]) => {
    if (!(theirs in (stored || {}))) return;
    const a = recomputed[mine];
    const b = typeof stored[theirs] === 'number' ? ratio(stored[theirs]) : stored[theirs];
    if (Math.abs((a ?? 0) - (b ?? 0)) > 0.0005) diffs.push(`${mine}: recomputed ${a} vs stored ${b}`);
  });
  return diffs;
}

function describeSubjectAblation(withRows, withoutRows) {
  // State exactly what differs, rather than calling it "no trusted context".
  const sample = withoutRows[0];
  const nulled = sample ? Object.entries(sample.expected).length : 0;
  return {
    whatDiffers:
      'The "without subject context" arm replaces every authenticated subject '
      + 'attribute value (organisation, role, jurisdiction, clearance, credential '
      + 'status, case assignment) with null, and the role-specific RBAC row in the '
      + 'system prompt becomes empty as a consequence. The ordered policy rules, '
      + 'the record/resource attributes and the request text are unchanged.',
    notAClaimAbout: 'This is not an ablation of all trusted context; resource '
      + 'context remains fully present in both arms.',
    matchedCases: withRows.length === withoutRows.length
      && withRows.every((r, i) => r.id === withoutRows[i].id),
    caseCount: withRows.length,
    _unused: nulled,
  };
}

(async () => {
  banner('EXPERIMENT 01 — model effectiveness and subject-context ablation');

  const loaded = [];
  for (const spec of RUN_FILES) {
    const file = path.join(RUNS, spec.file);
    if (!fs.existsSync(file)) {
      loaded.push({ ...spec, missing: true });
      process.stdout.write(`  MISSING  ${spec.file}\n`);
      continue;
    }
    const raw = fs.readFileSync(file);
    const run = JSON.parse(raw);
    const recomputed = score(run.rows);
    const diffs = crossCheck(recomputed, run.metrics);
    loaded.push({
      ...spec,
      missing: false,
      runFile: spec.file,
      runFileSha256: sha256(raw),
      config: {
        modelVersion: run.config.version,
        arm: run.config.arm,
        dataset: path.basename(run.config.data),
        datasetSha256: run.config.dataSha256,
        adapterSha256: run.config.adapterSha256,
        seed: run.config.seed,
        policyVersion: run.config.policyVersion,
      },
      metrics: recomputed,
      storedSummaryAgrees: diffs.length === 0,
      storedSummaryDifferences: diffs,
    });
    process.stdout.write(
      `  ${spec.label.padEnd(28)} n=${recomputed.n.toString().padStart(3)}  `
      + `joint=${(recomputed.jointAccuracy * 100).toFixed(1)}%  `
      + `decision=${(recomputed.decisionAccuracy * 100).toFixed(1)}%  `
      + `falseAllow=${recomputed.falseAllowCount}/${recomputed.nonAllowGroundTruth}  `
      + `${diffs.length ? `SUMMARY MISMATCH: ${diffs.join('; ')}` : 'summary agrees'}\n`
    );
  }

  const byLabel = Object.fromEntries(loaded.map((l) => [l.label, l]));
  const testArms = loaded.filter((l) => !l.missing && l.split === 'test');
  const withSubject = byLabel['V6 with subject context'];
  const withoutSubject = byLabel['V6 without subject context'];

  // The ablation is only meaningful across the identical case set.
  let ablation = null;
  if (withSubject && withoutSubject && !withSubject.missing && !withoutSubject.missing) {
    const a = JSON.parse(fs.readFileSync(path.join(RUNS, withSubject.runFile))).rows;
    const b = JSON.parse(fs.readFileSync(path.join(RUNS, withoutSubject.runFile))).rows;
    const shape = describeSubjectAblation(a, b);
    ablation = {
      ...shape,
      sameDatasetFile: withSubject.config.datasetSha256 === withoutSubject.config.datasetSha256,
      withSubject: withSubject.metrics,
      withoutSubject: withoutSubject.metrics,
      jointAccuracyDrop: ratio(withSubject.metrics.jointAccuracy - withoutSubject.metrics.jointAccuracy),
      decisionAccuracyDrop: ratio(
        withSubject.metrics.decisionAccuracy - withoutSubject.metrics.decisionAccuracy
      ),
    };
    process.stdout.write(
      `\n  subject-context ablation (matched cases: ${ablation.matchedCases}, n=${ablation.caseCount})\n`
      + `    joint ${(ablation.withSubject.jointAccuracy * 100).toFixed(1)}%`
      + ` -> ${(ablation.withoutSubject.jointAccuracy * 100).toFixed(1)}%`
      + `  (drop ${(ablation.jointAccuracyDrop * 100).toFixed(1)} points)\n`
    );
  }

  const gaps = [];
  if (!testArms.some((a) => a.config.arm === 'short' && a.config.modelVersion.includes('v6'))) {
    gaps.push('No V6 short-prompt arm was retained on the held-out test split, so the '
      + 'contribution of prompt grounding is measured only for V4.');
  }
  gaps.push('No non-fine-tuned baseline exists on this test split. Untuned arms were '
    + 'retained only against a superseded 60-case suite and are not comparable.');

  const payload = {
    metadata: metadata('EXP-01', {
      researchQuestion:
        'How accurately does the fine-tuned model perform SEAL authorization, and '
        + 'how much does the authenticated subject context contribute?',
      jointAccuracyDefinition:
        'action AND purpose AND decision AND reasonCode all correct, on a schema-valid output',
      scopeExclusion:
        'Deterministic-validator behaviour is deliberately excluded from this experiment. '
        + 'The retained runs replay a guard derived from the model\'s own action and purpose '
        + 'and their dataset carries no committed action/purpose, so those columns describe '
        + 'the pre-hardening validator. Experiment 02 owns all validator claims.',
      datasetFiles: fs.existsSync(DATA)
        ? fs.readdirSync(DATA).filter((f) => f.endsWith('.cases.json'))
        : [],
    }),
    summary: {
      arms: loaded.filter((l) => !l.missing).map((l) => ({
        label: l.label,
        split: l.split,
        modelVersion: l.config.modelVersion,
        arm: l.config.arm,
        n: l.metrics.n,
        decisionAccuracy: l.metrics.decisionAccuracy,
        jointAccuracy: l.metrics.jointAccuracy,
        actionAccuracy: l.metrics.actionAccuracy,
        purposeAccuracy: l.metrics.purposeAccuracy,
        reasonAccuracy: l.metrics.reasonAccuracy,
        macroF1: l.metrics.macroF1,
        falseAllowCount: l.metrics.falseAllowCount,
        nonAllowGroundTruth: l.metrics.nonAllowGroundTruth,
        falseDenyCount: l.metrics.falseDenyCount,
        schemaRejected: l.metrics.schemaRejected,
        medianInferenceMs: l.metrics.inferenceLatencyMs.median,
        p95InferenceMs: l.metrics.inferenceLatencyMs.p95,
        storedSummaryAgrees: l.storedSummaryAgrees,
      })),
      ablation,
      gaps,
      falseAllowObservation:
        'False-Allow counts are an observation on the retained held-out split at this '
        + 'model version. They are not a general guarantee about unseen requests.',
    },
    runs: loaded,
  };

  const jsonFile = writeJson('01-model-context', payload);
  const csvFile = writeCsv('01-model-context', payload.summary.arms);
  process.stdout.write(`\n  wrote ${path.basename(jsonFile)} and ${path.basename(csvFile)}\n`);

  const mismatches = loaded.filter((l) => !l.missing && !l.storedSummaryAgrees);
  if (mismatches.length) {
    process.stdout.write('\n  NOTE: recomputed metrics differ from a stored summary; see runs[].storedSummaryDifferences\n');
  }
  process.exit(0);
})().catch((error) => {
  process.stderr.write(`EXP-01 failed: ${error.message}\n`);
  process.exit(1);
});
