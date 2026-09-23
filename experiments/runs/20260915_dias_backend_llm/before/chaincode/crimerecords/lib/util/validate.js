'use strict';

/**
 * Strict allow-list input validation.
 *
 * This replaces the denylist (`FORBIDDEN_FIELDS` + object spread) approach
 * that let arbitrary caller-supplied fields reach the ledger in the previous
 * chaincode. Only fields named in a schema are copied; everything else is
 * rejected, and every value is type-checked.
 */

const crypto = require('crypto');

/** Deterministically stringify an object with sorted keys (for hashing). */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hashObject(obj) {
  return sha256(canonicalize(obj));
}

/**
 * Validate `input` against `schema` and return a NEW object containing only
 * schema fields. Schema entry: { type, required, enum?, pattern? }.
 * Unknown fields in the input are an error, not silently dropped, so a
 * client that tries to smuggle PII gets a loud failure.
 */
function validateAllowList(input, schema, label) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label}: expected a JSON object`);
  }
  const allowed = new Set(Object.keys(schema));
  const unknown = Object.keys(input).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    throw new Error(`${label}: unknown fields not permitted: ${unknown.join(', ')}`);
  }

  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = input[field];
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (rule.required) {
        throw new Error(`${label}: missing required field '${field}'`);
      }
      out[field] = rule.default !== undefined ? rule.default : null;
      continue;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        throw new Error(`${label}: field '${field}' must be a string`);
      }
      if (rule.pattern && !rule.pattern.test(value)) {
        throw new Error(`${label}: field '${field}' has invalid format`);
      }
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`${label}: field '${field}' must be a boolean`);
      }
    } else if (rule.type === 'stringArray') {
      const bad = !Array.isArray(value) || value.some((v) => typeof v !== 'string');
      if (bad) {
        throw new Error(`${label}: field '${field}' must be an array of strings`);
      }
    }
    if (rule.enum && !rule.enum.includes(value)) {
      throw new Error(
        `${label}: field '${field}' must be one of [${rule.enum.join(', ')}]`
      );
    }
    out[field] = value;
  }
  return out;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

module.exports = { validateAllowList, canonicalize, sha256, hashObject, SHA256_HEX, SAFE_ID };
