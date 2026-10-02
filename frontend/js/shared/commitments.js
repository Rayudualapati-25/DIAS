/**
 * dias-commitment-hash-v1 in the browser (docs/design/dias-v3-ledger-schema.md §4).
 *
 *   digest = SHA-256( UTF-8("DIAS/v3/" + domain) || 0x00 || content )
 *
 * The same rule as chaincode/crimerecords/lib/dias/commitments.js, written again
 * here because the page cannot load the contract's CommonJS module. Both are
 * tested against the same vectors and against each other.
 *
 * SHA-256 is implemented in plain JavaScript (FIPS 180-4) on purpose: Web Crypto
 * (crypto.subtle) exists only in secure contexts, and the testbed serves this
 * page over plain HTTP from another machine, where it is undefined.
 */

const DOMAIN_PREFIX = 'DIAS/v3/';
const DOMAINS = Object.freeze(['context', 'claims', 'justification', 'recommendation', 'note', 'policy']);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

/** Lowercase hexadecimal SHA-256 of a byte array. */
export function sha256Hex(bytes) {
  const length = bytes.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[length] = 0x80;
  const view = new DataView(data.buffer);
  const bitLength = length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + choice + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

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

/** Canonical JSON, exactly as the contract produces it. */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === true || value === false) return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`canonical JSON: ${value} is not a safe integer`);
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
      if (value[key] === undefined) throw new Error(`canonical JSON: property '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
    }).join(',')}}`;
  }
  throw new Error(`canonical JSON: values of type ${typeof value} cannot be represented`);
}

const encoder = new TextEncoder();

function digest(domain, contentBytes) {
  if (!DOMAINS.includes(domain)) throw new Error(`unknown commitment domain '${domain}'`);
  const prefix = encoder.encode(`${DOMAIN_PREFIX}${domain}\u0000`);
  const bytes = new Uint8Array(prefix.length + contentBytes.length);
  bytes.set(prefix);
  bytes.set(contentBytes, prefix.length);
  return sha256Hex(bytes);
}

/** Digest of text exactly as written (justification, note). */
export function hashText(domain, text) {
  if (typeof text !== 'string') throw new Error(`${domain} text must be a string`);
  if (UNPAIRED_SURROGATE.test(text)) {
    throw new Error(`${domain} text contains an unpaired surrogate and has no UTF-8 form`);
  }
  return digest(domain, encoder.encode(text));
}

/** Digest of structured content (the recommendation object, context, claims). */
export function hashCanonical(domain, value) {
  if (!DOMAINS.includes(domain)) throw new Error(`unknown commitment domain '${domain}'`);
  return digest(domain, encoder.encode(canonicalJson(value)));
}

export const isDigest = (value) => typeof value === 'string' && DIGEST_PATTERN.test(value);
