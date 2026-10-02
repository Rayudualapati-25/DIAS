'use strict';

/**
 * DIAS workflow parameters held on the ledger (dias-parameters-v1).
 *
 * Today one parameter: how long a request may wait for an auditor before it can
 * be expired (design §8). Absent a stored value the default applies, so a fresh
 * network works without a governance transaction. Values are validated strictly:
 * a parameter that is mistyped or out of range is refused rather than clamped.
 */

const PARAMETERS_KEY = 'diasParameters';
const PARAMETERS_ID = 'current';
const PARAMETERS_SCHEMA_VERSION = 'dias-parameters-v1';
const DEFAULT_PARAMETERS = Object.freeze({ pendingReviewTtlSeconds: 72 * 3600 });
const LIMITS = Object.freeze({ pendingReviewTtlSeconds: Object.freeze({ min: 60, max: 30 * 24 * 3600 }) });

/** Validated parameters from caller input; throws on any unknown, mistyped or out-of-range value. */
function validateParameters(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('DIAS parameters must be a JSON object');
  }
  const unknown = Object.keys(input).filter((key) => !Object.prototype.hasOwnProperty.call(LIMITS, key));
  if (unknown.length > 0) throw new Error(`unknown DIAS parameters: ${unknown.join(', ')}`);
  const value = input.pendingReviewTtlSeconds;
  const { min, max } = LIMITS.pendingReviewTtlSeconds;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`pendingReviewTtlSeconds must be an integer from ${min} to ${max}`);
  }
  return { pendingReviewTtlSeconds: value };
}

/** Stored parameters, or the defaults when none were ever set. */
async function readParameters(ctx) {
  const data = await ctx.stub.getState(ctx.stub.createCompositeKey(PARAMETERS_KEY, [PARAMETERS_ID]));
  if (!data || data.length === 0) return { ...DEFAULT_PARAMETERS, source: 'default' };
  const stored = JSON.parse(data.toString());
  return { pendingReviewTtlSeconds: stored.pendingReviewTtlSeconds, source: 'ledger' };
}

/** Deadline for a request committed at `timestampIso`. */
function reviewDeadline(timestampIso, parameters) {
  return new Date(Date.parse(timestampIso) + parameters.pendingReviewTtlSeconds * 1000).toISOString();
}

module.exports = {
  DEFAULT_PARAMETERS,
  LIMITS,
  PARAMETERS_ID,
  PARAMETERS_KEY,
  PARAMETERS_SCHEMA_VERSION,
  readParameters,
  reviewDeadline,
  validateParameters,
};
