'use strict';

/**
 * dias-commitment-hash-v1 — the one rule for every DIAS v3 hash commitment
 * (docs/design/dias-v3-ledger-schema.md §4).
 *
 *   digest = SHA-256( UTF-8("DIAS/v3/" + domain) || 0x00 || content )
 *
 * Structured content is canonical JSON: RFC 8785 for the value types DIAS uses
 * (keys sorted by UTF-16 code units, ECMAScript string escaping, no whitespace),
 * restricted to null, booleans, safe integers, strings, arrays and plain objects
 * so that every implementation produces the same bytes. Text content is the exact
 * string, UTF-8 encoded: no trimming and no Unicode normalization.
 *
 * Used unchanged by the contracts and the backend; the browser has its own
 * implementation in frontend/js/shared/commitments.js, tested against the same
 * vectors (test/fixtures/commitment-vectors.json).
 */

const crypto = require('crypto');

const HASH_FORMAT_VERSION = 'dias-commitment-hash-v1';
const DOMAIN_PREFIX = 'DIAS/v3/';
const DOMAINS = Object.freeze({
  CONTEXT: 'context',
  CLAIMS: 'claims',
  JUSTIFICATION: 'justification',
  RECOMMENDATION: 'recommendation',
  NOTE: 'note',
  POLICY: 'policy',
});
const KNOWN_DOMAINS = new Set(Object.values(DOMAINS));
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function assertWellFormed(text) {
  if (UNPAIRED_SURROGATE.test(text)) {
    throw new Error('canonical JSON: a string contains an unpaired surrogate and has no UTF-8 form');
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Canonical JSON text for `value`, or an error naming what cannot be represented. */
function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === true || value === false) return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonical JSON: ${value} is not a safe integer`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    assertWellFormed(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (item === undefined) throw new Error('canonical JSON: arrays may not contain undefined');
      return canonicalJson(item);
    }).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => {
      assertWellFormed(key);
      if (value[key] === undefined) {
        throw new Error(`canonical JSON: property '${key}' is undefined`);
      }
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(',')}}`;
  }
  throw new Error(`canonical JSON: values of type ${typeof value} cannot be represented`);
}

function domainPrefix(domain) {
  if (!KNOWN_DOMAINS.has(domain)) throw new Error(`unknown commitment domain '${domain}'`);
  return Buffer.from(`${DOMAIN_PREFIX}${domain}\u0000`, 'utf8');
}

function digest(domain, content) {
  return crypto.createHash('sha256').update(domainPrefix(domain)).update(content).digest('hex');
}

/** Digest of structured content (C, K, M, a policy bundle). */
function hashCanonical(domain, value) {
  domainPrefix(domain);
  return digest(domain, Buffer.from(canonicalJson(value), 'utf8'));
}

/** Digest of text exactly as written (J, N). */
function hashText(domain, text) {
  if (typeof text !== 'string') throw new Error(`${domain} text must be a string`);
  if (UNPAIRED_SURROGATE.test(text)) {
    throw new Error(`${domain} text contains an unpaired surrogate and has no UTF-8 form`);
  }
  return digest(domain, Buffer.from(text, 'utf8'));
}

const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);

function assertDigest(value, label) {
  if (!isDigest(value)) {
    throw new Error(`${label} must be a SHA-256 digest of 64 lowercase hexadecimal characters`);
  }
  return value;
}

module.exports = {
  DOMAINS,
  HASH_FORMAT_VERSION,
  assertDigest,
  canonicalJson,
  hashCanonical,
  hashText,
  isDigest,
};
