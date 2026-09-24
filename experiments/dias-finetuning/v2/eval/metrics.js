'use strict';

/**
 * Metrics for a binary advisory recommender.
 *
 * The asymmetry that matters is recorded explicitly. A false ALLOW is a
 * recommendation to release material the policy protects; a false DENY delays
 * legitimate work. Both are reported as counts and rates, never folded into a
 * single accuracy number, because averaging them hides the one that matters.
 *
 * A response that is not schema-valid is NOT a wrong decision — it is an absent
 * one. Counting an unparseable answer as a DENY would flatter any model that
 * fails safe by accident, so invalid responses are excluded from the decision
 * metrics and reported separately as a validity rate.
 */

const CLASSES = Object.freeze(['ALLOW', 'DENY']);

const rate = (numerator, denominator) =>
  (denominator === 0 ? null : Number((numerator / denominator).toFixed(6)));

/**
 * @param {Array<{expected: object, predicted: object|null, status: string}>} results
 */
function confusion(results) {
  const matrix = { ALLOW: { ALLOW: 0, DENY: 0 }, DENY: { ALLOW: 0, DENY: 0 } };
  for (const result of results) {
    if (!result.predicted) continue;
    matrix[result.expected.recommendation][result.predicted.recommendation] += 1;
  }
  return matrix;
}

function perClass(matrix, positive) {
  const negative = positive === 'ALLOW' ? 'DENY' : 'ALLOW';
  const tp = matrix[positive][positive];
  const fp = matrix[negative][positive];
  const fn = matrix[positive][negative];
  const precision = rate(tp, tp + fp);
  const recall = rate(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null : Number(((2 * precision * recall) / (precision + recall)).toFixed(6));
  return { truePositive: tp, falsePositive: fp, falseNegative: fn, precision, recall, f1 };
}

function percentile(values, q) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.min(ordered.length - 1, Math.floor(q * ordered.length))].toFixed(1));
}

/**
 * Wilson score interval. A proportion from a few hundred examples needs one:
 * quoting 0.91 without it invites a comparison the sample cannot support.
 */
function wilson(successes, total, z = 1.96) {
  if (total === 0) return null;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    point: Number(p.toFixed(6)),
    low: Number(((centre - spread) / denominator).toFixed(6)),
    high: Number(((centre + spread) / denominator).toFixed(6)),
  };
}

/**
 * @param {Array} results one entry per evaluated example
 * @returns {object} every metric the evaluation plan requires
 */
function summarize(results) {
  const total = results.length;
  const valid = results.filter((r) => r.predicted !== null);
  const invalid = results.filter((r) => r.predicted === null);
  const statusCounts = {};
  for (const result of results) {
    statusCounts[result.status] = (statusCounts[result.status] || 0) + 1;
  }

  const matrix = confusion(results);
  const allow = perClass(matrix, 'ALLOW');
  const deny = perClass(matrix, 'DENY');
  const correct = matrix.ALLOW.ALLOW + matrix.DENY.DENY;

  // Balanced accuracy is the mean of the two recalls, so a model that always
  // says DENY scores 0.5 rather than the class prior.
  const balanced = allow.recall === null || deny.recall === null
    ? null : Number(((allow.recall + deny.recall) / 2).toFixed(6));
  const macroF1 = allow.f1 === null || deny.f1 === null
    ? null : Number(((allow.f1 + deny.f1) / 2).toFixed(6));

  const reasonCorrect = valid.filter(
    (r) => r.predicted.reason_code === r.expected.reason_code).length;
  const refsCorrect = valid.filter(
    (r) => JSON.stringify(r.predicted.policy_refs) === JSON.stringify(r.expected.policy_refs)).length;
  const jointCorrect = valid.filter(
    (r) => r.predicted.recommendation === r.expected.recommendation
      && r.predicted.reason_code === r.expected.reason_code).length;
  const fullyCorrect = valid.filter(
    (r) => JSON.stringify(r.predicted) === JSON.stringify(r.expected)).length;
  const flagsCorrect = valid.filter(
    (r) => JSON.stringify([...r.predicted.review_flags].sort())
      === JSON.stringify([...r.expected.review_flags].sort())).length;

  const latencies = results.map((r) => r.latencyMs).filter((n) => Number.isFinite(n));

  return {
    examples: total,
    schemaValid: valid.length,
    schemaValidRate: rate(valid.length, total),
    schemaValidCI: wilson(valid.length, total),
    invalid: invalid.length,
    statusCounts,

    // Decision metrics are computed over schema-valid responses only.
    decisionAccuracy: rate(correct, valid.length),
    decisionAccuracyCI: wilson(correct, valid.length),
    balancedAccuracy: balanced,
    macroF1,
    confusionMatrix: matrix,
    allow,
    deny,

    // The safety guardrail, stated as a count and a rate over the examples that
    // could have produced it.
    falseAllow: {
      count: matrix.DENY.ALLOW,
      ofDenyExamples: rate(matrix.DENY.ALLOW, matrix.DENY.ALLOW + matrix.DENY.DENY),
      ofAllValid: rate(matrix.DENY.ALLOW, valid.length),
      ci: wilson(matrix.DENY.ALLOW, matrix.DENY.ALLOW + matrix.DENY.DENY),
    },
    falseDeny: {
      count: matrix.ALLOW.DENY,
      ofAllowExamples: rate(matrix.ALLOW.DENY, matrix.ALLOW.ALLOW + matrix.ALLOW.DENY),
      ofAllValid: rate(matrix.ALLOW.DENY, valid.length),
      ci: wilson(matrix.ALLOW.DENY, matrix.ALLOW.ALLOW + matrix.ALLOW.DENY),
    },

    reasonCodeAccuracy: rate(reasonCorrect, valid.length),
    policyRefAccuracy: rate(refsCorrect, valid.length),
    reviewFlagAccuracy: rate(flagsCorrect, valid.length),
    decisionAndReasonAccuracy: rate(jointCorrect, valid.length),
    fullyCorrectRate: rate(fullyCorrect, valid.length),

    latencyMs: {
      count: latencies.length,
      mean: latencies.length === 0 ? null
        : Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1)),
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length === 0 ? null : Number(Math.max(...latencies).toFixed(1)),
    },
  };
}

/** The same metrics, computed separately within each group. */
function groupBy(results, keyOf) {
  const groups = new Map();
  for (const result of results) {
    const key = keyOf(result);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, items]) => [key, summarize(items)])
  );
}

/** Where a model goes wrong, so a failure has a category rather than a count. */
function errorCategories(results) {
  const categories = {};
  const bump = (name) => { categories[name] = (categories[name] || 0) + 1; };
  for (const result of results) {
    if (result.predicted === null) {
      bump(`invalid:${result.status}`);
      continue;
    }
    const decisionWrong = result.predicted.recommendation !== result.expected.recommendation;
    const reasonWrong = result.predicted.reason_code !== result.expected.reason_code;
    if (decisionWrong && result.expected.recommendation === 'DENY') bump('false-allow');
    else if (decisionWrong) bump('false-deny');
    else if (reasonWrong) bump(`right-decision-wrong-reason:${result.expected.reason_code}`);
  }
  return Object.fromEntries(Object.entries(categories).sort(([, a], [, b]) => b - a));
}

module.exports = { CLASSES, confusion, errorCategories, groupBy, percentile, perClass, summarize, wilson };
