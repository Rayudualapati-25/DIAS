#!/usr/bin/env node
'use strict';

/**
 * DIAS binary recommendation dataset v2.
 *
 * Purpose: supervised fine-tuning and held-out evaluation of an ADVISORY
 * ALLOW/DENY access recommendation model. Labels come from the versioned written
 * governance policy through the offline reference oracle. Auditor overrides are
 * never used as labels: an override is an exceptional governance act recorded in
 * the dynamic-authorization system, and training the model to predict one would
 * teach it to imitate the authority it is explicitly denied.
 *
 * What this generator fixes, relative to data-v1:
 *   - usernames no longer contain the role or the split name;
 *   - record and case identifiers no longer occupy per-reason numeric ranges;
 *   - cross-jurisdiction is two different real districts, not `outside-<x>`;
 *   - all three clearance levels appear, so the ordered comparison is exercised;
 *   - emergency and approval flags vary independently of the label;
 *   - multi-clause failures exist at all (v1 had none), so precedence is tested;
 *   - paraphrases and near-miss partners cannot cross a split;
 *   - a held-out template family set measures phrasing generalisation;
 *   - INVALID_PURPOSE is excluded: the runtime rejects it before inference.
 *
 *   node experiments/dias-finetuning/v2/generate.js [--seed 20260912] [--out <dir>]
 */

const fs = require('fs');
const path = require('path');

const { loadBundle } = require('../../../policies/lib/bundle');
const { createPolicyContextProvider } = require('../../../backend/src/dias/policyContextProvider');
const { PROMPT_VERSION } = require('../../../backend/src/dias/recommendationPrompt');
const {
  RESPONSE_SCHEMA_VERSION,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationSchema');
const { createRng } = require('./lib/rng');
const { createIdentifierFactory } = require('./lib/identifiers');
const { roleIndex } = require('./lib/world');
const scenarios = require('./lib/scenarios');
const { HELD_OUT_FAMILIES, FAMILY_BY_ID } = require('./lib/justifications');
const { buildExample, sha256 } = require('./lib/example');
const { createFamily, splitForFamily } = require('./lib/families');
const { PLAN, POOLS, SPLIT_WEIGHTS, pickPool } = require('./lib/plan');

const DATASET_VERSION = 'dias-recommendation-dataset-v2-binary';
const DEFAULT_SEED = 20260912;
const DEFAULT_OUT = path.resolve(__dirname, '..', 'data-v2-binary');
const MAX_ATTEMPTS = 40;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith('--') ? true : (i += 1, next);
  }
  return args;
}

/** One generation run. Everything it needs is derived from the seed. */
function createContext(seed) {
  const { bundle, bundleHash } = loadBundle();
  const provider = createPolicyContextProvider({});
  return {
    seed,
    bundle,
    bundleHash,
    provider,
    index: roleIndex(bundle),
    identifiers: createIdentifierFactory(seed),
    rng: createRng(seed, 'generate'),
  };
}

/** Attach fresh, neutral identifiers to a set of facts. */
function withIdentifiers(context, facts) {
  const caseId = context.identifiers.caseId();
  return {
    facts: { ...facts, resource: { ...facts.resource, caseId } },
    identifiers: {
      username: context.identifiers.username(),
      recordId: context.identifiers.recordId(),
      exampleId: context.identifiers.exampleId(),
      caseId,
    },
  };
}

/**
 * Emit every variant of one set of facts into a family.
 *
 * Variants differ only in phrasing, and `heldOut` swaps the pool for the
 * template families that never appear in training.
 */
function emitVariants(context, family, facts, spec, { heldOut = false } = {}) {
  const { facts: withCase, identifiers } = withIdentifiers(context, facts);
  const policyContext = context.provider.assemble(withCase);
  const seen = new Set();
  for (let variant = 0; variant < spec.variants; variant += 1) {
    const familyId = heldOut
      ? context.rng.pick(HELD_OUT_FAMILIES).id
      : context.rng.pick(POOLS[pickPool(context.rng, spec.mix)]);
    const templateIndex = context.rng.int(0, FAMILY_BY_ID.get(familyId).templates.length - 1);
    const key = `${familyId}:${templateIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const example = buildExample({
      bundle: context.bundle,
      policyContext,
      facts: withCase,
      identifiers: { ...identifiers, exampleId: context.identifiers.exampleId() },
      justification: { familyId, templateIndex },
      provenance: {
        familyId: family.familyId,
        scenario: family.scenario,
        targetClauses: family.targetClauses,
        splitGroup: family.familyId,
        justificationKind: FAMILY_BY_ID.get(familyId).kind,
      },
      rng: context.rng,
    });
    family.add(example);
  }
}

/** Build one family, retrying the construction when the scenario cannot be met. */
function buildFamily(context, { scenario, targetClauses, construct, spec, heldOut, splitOverride }) {
  const familyId = context.identifiers.familyId();
  const split = splitOverride
    || splitForFamily(familyId, (text) => sha256(`${context.seed}::${text}`), SPLIT_WEIGHTS);
  const family = createFamily({ familyId, scenario, targetClauses, split });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const built = construct();
    if (built === null || built === undefined) continue;
    const factsList = Array.isArray(built) ? built : [built];
    if (factsList.some((facts) => facts === null)) continue;
    for (const facts of factsList) emitVariants(context, family, facts, spec, { heldOut });
    return family.close();
  }
  return [];
}

function generateCleanAllow(context) {
  const spec = PLAN.cleanAllow;
  const out = [];
  for (let i = 0; i < spec.families; i += 1) {
    out.push(...buildFamily(context, {
      scenario: 'clean-allow',
      targetClauses: [],
      spec,
      construct: () => scenarios.cleanAllow(context.rng, context.bundle, context.index),
    }));
  }
  return out;
}

function generateSingleViolations(context) {
  const spec = PLAN.singleViolation;
  const out = [];
  for (const clause of scenarios.SINGLE_VIOLATION_CLAUSES) {
    for (let i = 0; i < spec.familiesPerClause; i += 1) {
      out.push(...buildFamily(context, {
        scenario: 'single-violation',
        targetClauses: [clause],
        spec,
        construct: () =>
          scenarios.singleViolation(context.rng, context.bundle, clause, context.index),
      }));
    }
  }
  return out;
}

function generateMultiViolations(context) {
  const spec = PLAN.multiViolation;
  const clauses = scenarios.SINGLE_VIOLATION_CLAUSES;
  const out = [];
  for (let i = 0; i < spec.families; i += 1) {
    const chosen = context.rng.sample(clauses, context.rng.int(2, 3));
    out.push(...buildFamily(context, {
      scenario: 'multi-violation',
      targetClauses: chosen,
      spec,
      construct: () =>
        scenarios.multiViolation(context.rng, context.bundle, chosen, context.index),
    }));
  }
  return out;
}

/**
 * Near misses. Both halves of a pair live in one family, so the ALLOW side can
 * never train while the DENY side tests.
 */
function generateNearMisses(context) {
  const spec = PLAN.nearMiss;
  const out = [];
  for (const kind of scenarios.NEAR_MISS_KINDS) {
    for (let i = 0; i < spec.familiesPerKind; i += 1) {
      out.push(...buildFamily(context, {
        scenario: `near-miss:${kind}`,
        targetClauses: [],
        spec,
        construct: () => {
          const pair = scenarios.nearMiss(context.rng, context.bundle, kind, context.index);
          if (!pair.allow || !pair.deny) return null;
          return [pair.allow, pair.deny];
        },
      }));
    }
  }
  return out;
}

/** Attacks against facts that would otherwise be ALLOW, and against DENY facts. */
function generateAdversarial(context) {
  const spec = PLAN.adversarial;
  const out = [];
  for (let i = 0; i < spec.families; i += 1) {
    const attackAllow = context.rng.bool(0.5);
    const clause = context.rng.pick(scenarios.SINGLE_VIOLATION_CLAUSES);
    out.push(...buildFamily(context, {
      scenario: attackAllow ? 'adversarial-on-allow' : 'adversarial-on-deny',
      targetClauses: attackAllow ? [] : [clause],
      spec,
      construct: () => (attackAllow
        ? scenarios.cleanAllow(context.rng, context.bundle, context.index)
        : scenarios.singleViolation(context.rng, context.bundle, clause, context.index)),
    }));
  }
  return out;
}

/** Held-out phrasing. Forced to the test split: these must never train. */
function generateOodParaphrase(context) {
  const spec = PLAN.oodParaphrase;
  const out = [];
  for (let i = 0; i < spec.families; i += 1) {
    const allow = context.rng.bool(0.5);
    const clause = context.rng.pick(scenarios.SINGLE_VIOLATION_CLAUSES);
    out.push(...buildFamily(context, {
      scenario: 'ood-paraphrase',
      targetClauses: allow ? [] : [clause],
      spec,
      heldOut: true,
      splitOverride: 'test',
      construct: () => (allow
        ? scenarios.cleanAllow(context.rng, context.bundle, context.index)
        : scenarios.singleViolation(context.rng, context.bundle, clause, context.index)),
    }));
  }
  return out;
}

/**
 * Workflow cases. These are not training data: they drive the live Fabric
 * scenarios, where the model's answer decides which branch is exercised.
 */
function generateWorkflow(context) {
  const spec = PLAN.workflow;
  const out = [];
  for (let i = 0; i < spec.families; i += 1) {
    const allow = context.rng.bool(0.5);
    const clause = context.rng.pick(scenarios.SINGLE_VIOLATION_CLAUSES);
    out.push(...buildFamily(context, {
      scenario: 'workflow',
      targetClauses: allow ? [] : [clause],
      spec,
      splitOverride: 'workflow',
      construct: () => (allow
        ? scenarios.cleanAllow(context.rng, context.bundle, context.index)
        : scenarios.singleViolation(context.rng, context.bundle, clause, context.index)),
    }));
  }
  return out;
}

/** Drop any example whose prompt already appeared. Families keep their first copy. */
function deduplicate(examples) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const example of examples) {
    if (seen.has(example.meta.promptHash)) {
      dropped += 1;
      continue;
    }
    seen.add(example.meta.promptHash);
    kept.push(example);
  }
  return { kept, dropped };
}

/** Balance ALLOW and DENY by discarding surplus, never by duplicating. */
function balance(rng, examples) {
  const allow = examples.filter((e) => e.meta.label.recommendation === 'ALLOW');
  const deny = examples.filter((e) => e.meta.label.recommendation === 'DENY');
  const size = Math.min(allow.length, deny.length);
  return rng.shuffle([...rng.shuffle(allow).slice(0, size), ...rng.shuffle(deny).slice(0, size)]);
}

module.exports = {
  DATASET_VERSION,
  DEFAULT_OUT,
  DEFAULT_SEED,
  PROMPT_VERSION,
  RESPONSE_SCHEMA_VERSION,
  balance,
  buildFamily,
  createContext,
  deduplicate,
  generateAdversarial,
  generateCleanAllow,
  generateMultiViolations,
  generateNearMisses,
  generateOodParaphrase,
  generateSingleViolations,
  generateWorkflow,
  parseArgs,
};

// --- orchestration -------------------------------------------------------

const { assembleSplits, describeSet } = require('./lib/assemble');
const {
  labelSourceHashes, toCaseLine, toTrainingLine, writeJsonl, writeReviewSample,
} = require('./lib/writeDataset');

/** Target sizes. A set that cannot be filled is reported short, never padded. */
const SET_SIZES = Object.freeze({
  validation: 400,
  decision: 600,
  perReason: 60,
  adversarial: 400,
  ood: 400,
  multiRule: 400,
  workflow: 60,
});

function generatePool(context) {
  return [
    ...generateCleanAllow(context),
    ...generateSingleViolations(context),
    ...generateMultiViolations(context),
    ...generateNearMisses(context),
    ...generateAdversarial(context),
    ...generateOodParaphrase(context),
    ...generateWorkflow(context),
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number(args.seed || DEFAULT_SEED);
  const outDir = args.out ? path.resolve(args.out) : DEFAULT_OUT;
  const startedAt = new Date();

  const context = createContext(seed);
  const raw = generatePool(context);
  const { kept, dropped } = deduplicate(raw);
  const sets = assembleSplits({
    rng: context.rng.stream('assemble'), pool: kept, sizes: SET_SIZES,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const artifacts = {};
  const summary = {};
  for (const [name, examples] of Object.entries(sets)) {
    artifacts[`${name}.jsonl`] = writeJsonl(
      path.join(outDir, `${name}.jsonl`), examples.map(toTrainingLine));
    artifacts[`${name}.cases.jsonl`] = writeJsonl(
      path.join(outDir, `${name}.cases.jsonl`), examples.map(toCaseLine));
    summary[name] = describeSet(examples);
  }

  // MLX-LM expects train.jsonl / valid.jsonl / test.jsonl in the data directory.
  artifacts['valid.jsonl'] = writeJsonl(
    path.join(outDir, 'valid.jsonl'), sets['validation-balanced'].map(toTrainingLine));
  artifacts['test.jsonl'] = writeJsonl(
    path.join(outDir, 'test.jsonl'), sets['test-decision-balanced'].map(toTrainingLine));

  const review = writeReviewSample(
    path.join(outDir, 'human-review-sample.csv'), kept, context.rng.stream('review'), 3);

  const manifest = {
    datasetVersion: DATASET_VERSION,
    purpose: 'Supervised fine-tuning and held-out evaluation of an ADVISORY binary '
      + 'ALLOW/DENY access recommendation model. The model never grants or denies access.',
    generatedAtUtc: startedAt.toISOString(),
    seed,
    deterministic: true,
    labelSource: {
      method: 'offline reference oracle applied to the versioned written governance policy',
      bundleId: context.bundle.bundleId,
      bundleVersion: context.bundle.version,
      bundleHash: context.bundleHash,
      oracle: 'policies/reference-oracle/referencePolicyOracle.js',
      auditorOverridesUsedAsLabels: false,
      note: 'Auditor FORCE_ALLOW/FORCE_DENY decisions are governance acts recorded in the '
        + 'dynamic-authorization system. They are never training labels.',
    },
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    generation: {
      familiesPlanned: PLAN,
      rawExamples: raw.length,
      duplicatePromptsDropped: dropped,
      pooledExamples: kept.length,
      splitWeights: SPLIT_WEIGHTS,
      setSizeTargets: SET_SIZES,
    },
    sets: summary,
    artifacts,
    humanReview: {
      ...review,
      reviewStatus: 'pending_manual_review',
      claim: 'NOT REVIEWED. This file is a stratified sample prepared for review. '
        + 'No part of this repository may describe the dataset as human-reviewed until a '
        + 'person has filled in reviewer_verdict for these rows.',
    },
    labelSourceHashes: labelSourceHashes(),
    knownExclusions: {
      INVALID_PURPOSE: 'Excluded. The API and the chaincode reject an out-of-vocabulary '
        + 'purpose before a request is committed, so the live model can never see one. '
        + 'See docs/policies/policy-open-questions.md section 7.',
    },
    distributionClaim: 'SYNTHETIC. The class balance and scenario mix are chosen for '
      + 'training and measurement, not observed from deployment. No production prevalence '
      + 'is known for this system, so no set here should be read as production-like.',
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  console.log(`generated ${kept.length} examples from ${raw.length} raw (${dropped} duplicate prompts dropped) in ${seconds}s`);
  for (const [name, stats] of Object.entries(summary)) {
    console.log(`  ${name.padEnd(26)} ${String(stats.examples).padStart(5)} examples  `
      + `ALLOW ${String(stats.allow).padStart(4)}  DENY ${String(stats.deny).padStart(4)}  `
      + `families ${stats.families}`);
  }
  console.log(`  human-review sample: ${review.rows} rows across ${review.strata} strata (pending_manual_review)`);
  console.log(`written to ${outDir}`);
}

if (require.main === module) main();
