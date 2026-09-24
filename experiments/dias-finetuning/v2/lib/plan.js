'use strict';

/**
 * How many families of each kind to build, and which justification families
 * each kind may draw from.
 *
 * The counts are a starting pool, not a claim about the right training size.
 * The final training count is chosen from a learning curve over subsets of this
 * pool (see the training plan); generating more duplicated synthetic examples is
 * not assumed to help.
 */

const {
  CONTRADICTORY_FAMILIES, INJECTION_FAMILIES, PLAIN_FAMILIES, VERBOSE_FAMILIES,
} = require('./justifications');

const ids = (families) => families.map((family) => family.id);

/** Justification pools, by how honest the text is. */
const POOLS = Object.freeze({
  plain: ids(PLAIN_FAMILIES),
  verbose: ids(VERBOSE_FAMILIES),
  contradictory: ids(CONTRADICTORY_FAMILIES),
  injection: ids(INJECTION_FAMILIES),
});

/**
 * Mixture used for ordinary scenarios. Adversarial text is a minority of
 * training traffic, as it would be in reality, but is never absent: a model that
 * has seen no injection attempts has no reason to resist one.
 */
const DEFAULT_MIX = Object.freeze([
  { pool: 'plain', weight: 0.55 },
  { pool: 'verbose', weight: 0.10 },
  { pool: 'contradictory', weight: 0.20 },
  { pool: 'injection', weight: 0.15 },
]);

/** Adversarial scenarios draw only from text that attacks. */
const ADVERSARIAL_MIX = Object.freeze([
  { pool: 'contradictory', weight: 0.5 },
  { pool: 'injection', weight: 0.5 },
]);

const PLAIN_ONLY_MIX = Object.freeze([{ pool: 'plain', weight: 1 }]);

function pickPool(rng, mix) {
  const point = rng.next();
  let cumulative = 0;
  for (const entry of mix) {
    cumulative += entry.weight;
    if (point < cumulative) return entry.pool;
  }
  return mix[mix.length - 1].pool;
}

/**
 * Generation plan.
 *
 * `variants` is how many phrasings of the same facts a family contains. Keeping
 * it above one is what makes family grouping meaningful; keeping it small stops
 * the dataset from being mostly repetition.
 */
const PLAN = Object.freeze({
  cleanAllow: { families: 900, variants: 2, mix: DEFAULT_MIX },
  singleViolation: { familiesPerClause: 110, variants: 2, mix: DEFAULT_MIX },
  // Multi-clause and adversarial families are generated well above their
  // training need: only the ~20% of families that land in `test` can fill
  // `test-multi-rule` and `test-adversarial`, and a held-out set is not worth
  // reporting if it is too small to separate models.
  multiViolation: { families: 1000, variants: 2, mix: DEFAULT_MIX },
  nearMiss: { familiesPerKind: 110, variants: 2, mix: DEFAULT_MIX },
  adversarial: { families: 1000, variants: 2, mix: ADVERSARIAL_MIX },
  oodParaphrase: { families: 420, variants: 2, mix: PLAIN_ONLY_MIX },
  workflow: { families: 60, variants: 1, mix: PLAIN_ONLY_MIX },
});

/** Split weights. Test is generous because six held-out sets are cut from it. */
const SPLIT_WEIGHTS = Object.freeze({ train: 0.70, validation: 0.10, test: 0.20 });

module.exports = { ADVERSARIAL_MIX, DEFAULT_MIX, PLAIN_ONLY_MIX, PLAN, POOLS, SPLIT_WEIGHTS, pickPool };
