'use strict';

/**
 * Cut the generated pool into the training set and the evaluation sets.
 *
 * Every evaluation set is drawn from families assigned to `test` (or, for
 * validation, to `validation`). Nothing is ever moved between splits to make a
 * set the right size: a set that cannot be filled is reported short, because
 * padding it from the training split would destroy the only property that makes
 * the numbers meaningful.
 */

const isAllow = (example) => example.meta.label.recommendation === 'ALLOW';
const scenarioIs = (prefix) => (example) => example.meta.scenario.startsWith(prefix);

/** Equal ALLOW and DENY, capped at `limit` and never duplicating. */
function balancedSample(rng, examples, limit) {
  const allow = rng.shuffle(examples.filter(isAllow));
  const deny = rng.shuffle(examples.filter((e) => !isAllow(e)));
  const size = Math.min(allow.length, deny.length, Math.floor(limit / 2));
  return rng.shuffle([...allow.slice(0, size), ...deny.slice(0, size)]);
}

/** Equal numbers per reason code, so a rare code is not drowned by POLICY_SATISFIED. */
function reasonBalancedSample(rng, examples, perReason) {
  const byReason = new Map();
  for (const example of examples) {
    const code = example.meta.label.reason_code;
    if (!byReason.has(code)) byReason.set(code, []);
    byReason.get(code).push(example);
  }
  const picked = [...byReason.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, items]) => rng.shuffle(items).slice(0, perReason));
  return rng.shuffle(picked);
}

/**
 * @param {object} options
 * @param {object} options.rng
 * @param {Array} options.pool every generated example, already deduplicated
 * @param {object} options.sizes target sizes per evaluation set
 */
function assembleSplits({ rng, pool, sizes }) {
  const trainPool = pool.filter((e) => e.meta.split === 'train');
  const validationPool = pool.filter((e) => e.meta.split === 'validation');
  const testPool = pool.filter((e) => e.meta.split === 'test');
  const workflowPool = pool.filter((e) => e.meta.split === 'workflow');

  // The OOD families are forced to test; they must not appear anywhere else.
  const ood = testPool.filter(scenarioIs('ood-paraphrase'));
  const testRest = testPool.filter((e) => !e.meta.scenario.startsWith('ood-paraphrase'));

  return {
    // Training is balanced by discarding surplus of the majority class.
    train: balancedSample(rng, trainPool.filter((e) => !scenarioIs('ood-paraphrase')(e)), trainPool.length),
    'validation-balanced': balancedSample(rng, validationPool, sizes.validation),
    'test-decision-balanced': balancedSample(rng, testRest, sizes.decision),
    'test-reason-balanced': reasonBalancedSample(rng, testRest, sizes.perReason),
    'test-adversarial': rng.shuffle(testRest.filter(scenarioIs('adversarial'))).slice(0, sizes.adversarial),
    'test-ood-paraphrase': balancedSample(rng, ood, sizes.ood),
    'test-multi-rule': rng.shuffle(testRest.filter(scenarioIs('multi-violation'))).slice(0, sizes.multiRule),
    'workflow-evaluation': rng.shuffle(workflowPool).slice(0, sizes.workflow),
  };
}

/** Counts a reader needs to judge whether a set means anything. */
function describeSet(examples) {
  const counts = { ALLOW: 0, DENY: 0 };
  const reasons = {};
  const scenarios = {};
  const justificationKinds = {};
  const flags = {};
  for (const example of examples) {
    const { label, scenario, justificationKind } = example.meta;
    counts[label.recommendation] += 1;
    reasons[label.reason_code] = (reasons[label.reason_code] || 0) + 1;
    scenarios[scenario] = (scenarios[scenario] || 0) + 1;
    justificationKinds[justificationKind] = (justificationKinds[justificationKind] || 0) + 1;
    for (const flag of label.review_flags) flags[flag] = (flags[flag] || 0) + 1;
  }
  return {
    examples: examples.length,
    allow: counts.ALLOW,
    deny: counts.DENY,
    allowShare: examples.length === 0 ? 0 : Number((counts.ALLOW / examples.length).toFixed(4)),
    families: new Set(examples.map((e) => e.meta.scenarioFamily)).size,
    reasonCodes: reasons,
    scenarios,
    justificationKinds,
    reviewFlags: flags,
  };
}

module.exports = { assembleSplits, balancedSample, describeSet, reasonBalancedSample };
