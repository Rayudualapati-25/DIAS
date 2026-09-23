'use strict';

/**
 * Parse raw model text into a DIAS recommendation.
 *
 * Formatting tolerances are limited and recorded: surrounding whitespace, one
 * empty <think></think> block, and one surrounding markdown code fence. Everything
 * else must satisfy the shared response schema exactly, otherwise the result is
 * INVALID_OUTPUT and no recommendation is fabricated.
 */

const {
  GENERATION_STATUS, normalizeRecommendation, validateRecommendationOutput,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationSchema');

const EMPTY_THINK_BLOCK = /^<think>\s*<\/think>\s*/;
const CODE_FENCE = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/;

function extractJsonObject(text) {
  const tolerances = [];
  let body = String(text ?? '').trim();
  const think = body.match(EMPTY_THINK_BLOCK);
  if (think) {
    body = body.slice(think[0].length).trim();
    tolerances.push('removed_empty_think_block');
  }
  const fence = body.match(CODE_FENCE);
  if (fence) {
    body = fence[1].trim();
    tolerances.push('removed_code_fence');
  }
  if (!body.startsWith('{') || !body.endsWith('}')) {
    return { error: 'output is not a single JSON object', tolerances };
  }
  try {
    return { value: JSON.parse(body), tolerances };
  } catch (_error) {
    return { error: 'output is not valid JSON', tolerances };
  }
}

/**
 * @param {string} text raw model output
 * @param {object} policy { clauseRefs, reasonCodes, reviewFlags } of the active bundle
 */
function parseRecommendation(text, policy) {
  const extracted = extractJsonObject(text);
  if (extracted.error) {
    return {
      status: GENERATION_STATUS.INVALID_OUTPUT,
      recommendation: null,
      errors: [extracted.error],
      tolerances: extracted.tolerances,
    };
  }
  const errors = validateRecommendationOutput(extracted.value, policy);
  if (errors.length > 0) {
    return {
      status: GENERATION_STATUS.INVALID_OUTPUT,
      recommendation: null,
      errors,
      tolerances: extracted.tolerances,
    };
  }
  return {
    status: GENERATION_STATUS.OK,
    recommendation: normalizeRecommendation(extracted.value),
    errors: [],
    tolerances: extracted.tolerances,
  };
}

module.exports = { extractJsonObject, parseRecommendation };
