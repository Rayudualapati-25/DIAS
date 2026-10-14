'use strict';

/** Parse raw model text into a DIAS recommendation. */

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
