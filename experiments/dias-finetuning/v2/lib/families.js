'use strict';

/** Scenario families and split assignment. */

const SPLITS = Object.freeze(['train', 'validation', 'test']);

/** Deterministic split for a family, from its id alone. */
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
 * A family under construction. `emit` collects examples; `close` returns them all tagged with the family's
 * split, so no member can be assigned separately.
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
