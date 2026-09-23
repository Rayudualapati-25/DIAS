'use strict';

/**
 * Scenario families and split assignment.
 *
 * A family is one situation together with every variant of it: the same facts
 * re-phrased, and the near-miss partner that flips the label on one field. The
 * whole family goes to one split.
 *
 * This is the only defence against a leak that looks like generalisation. If the
 * ALLOW half of a clearance boundary pair trains and the DENY half tests, the
 * test measures recall of an almost-identical prompt. Grouping is therefore done
 * before splitting, and the validator re-checks it on the written files rather
 * than trusting that this code ran correctly.
 */

const SPLITS = Object.freeze(['train', 'validation', 'test']);

/**
 * Deterministic split for a family, from its id alone.
 *
 * Hashing the id rather than counting keeps assignment stable when families are
 * added or reordered: an existing family stays in the split it was in, so a
 * regenerated dataset does not quietly move test examples into training.
 */
function splitForFamily(familyId, hash, weights) {
  const digest = hash(`split::${familyId}`);
  const point = parseInt(digest.slice(0, 8), 16) / 0x100000000;
  let cumulative = 0;
  for (const split of SPLITS) {
    cumulative += weights[split];
    if (point < cumulative) return split;
  }
  return SPLITS[SPLITS.length - 1];
}

/**
 * A family under construction. `emit` collects examples; `close` returns them
 * all tagged with the family's split, so no member can be assigned separately.
 */
function createFamily({ familyId, scenario, targetClauses, split }) {
  const examples = [];
  return {
    familyId,
    scenario,
    targetClauses,
    split,
    add(example) {
      examples.push(example);
      return example;
    },
    close() {
      return examples.map((example) => ({
        ...example,
        meta: { ...example.meta, split },
      }));
    },
  };
}

module.exports = { SPLITS, createFamily, splitForFamily };
