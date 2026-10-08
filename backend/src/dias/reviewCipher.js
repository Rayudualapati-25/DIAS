'use strict';

/**
 * Encryption of the off-chain review store at rest (design §10).
 *
 * AES-256-GCM with a random 96-bit IV per write. The additional authenticated
 * data is the envelope schema version and the request identifier, so a file moved
 * to another request does not open. Each envelope names the key that sealed it;
 * earlier keys stay available for reading after a rotation, and every new write
 * uses the current key.
 *
 * What this protects: copies of the store at rest and in backups. What it does
 * not: the backend process, which holds the key. Losing the key loses the
 * off-chain objects; the ledger still holds their digests, the recommendation
 * value and the status.
 */

const crypto = require('crypto');

const ENCRYPTED_REVIEW_SCHEMA_VERSION = 'dias-offchain-review-encrypted-v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const associatedData = (requestId) => Buffer.from(`${ENCRYPTED_REVIEW_SCHEMA_VERSION}\u0000${requestId}`, 'utf8');

function createReviewCipher({ keyId, key, previousKeys = [] }) {
  const keys = new Map();
  for (const item of [{ keyId, key }, ...previousKeys]) {
    if (!KEY_ID.test(item.keyId || '')) throw new Error('a review store key identifier has invalid format');
    if (!Buffer.isBuffer(item.key) || item.key.length !== KEY_BYTES) {
      throw new Error(`review store key '${item.keyId}' must be ${KEY_BYTES} bytes`);
    }
    if (keys.has(item.keyId)) throw new Error(`review store key identifier '${item.keyId}' is used twice`);
    keys.set(item.keyId, item.key);
  }

  /** Encrypt one review entry for `requestId` under the current key. */
  function seal(requestId, entry) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, keys.get(keyId), iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(requestId));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entry), 'utf8'), cipher.final()]);
    return {
      schemaVersion: ENCRYPTED_REVIEW_SCHEMA_VERSION,
      requestId,
      keyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  /** Decrypt the envelope stored for `requestId`, or throw without revealing anything. */
  function open(requestId, envelope) {
    if (envelope.requestId !== requestId) {
      throw new Error(`the stored review belongs to request '${envelope.requestId}', not '${requestId}'`);
    }
    const key = keys.get(envelope.keyId);
    if (!key) throw new Error(`this store has no key '${envelope.keyId}' to decrypt the review of '${requestId}'`);
    try {
      const iv = Buffer.from(String(envelope.iv), 'base64');
      const tag = Buffer.from(String(envelope.tag), 'base64');
      // A shortened tag would weaken the check, so only the full length is accepted.
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('unexpected IV or tag length');
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(associatedData(requestId));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch (_error) {
      throw new Error(`the stored review of '${requestId}' could not be decrypted: wrong key or changed content`);
    }
  }

  return Object.freeze({ keyId, seal, open });
}

const isEncryptedReview = (value) => Boolean(value) && value.schemaVersion === ENCRYPTED_REVIEW_SCHEMA_VERSION;

/** A 32-byte key from its base64 form; the error names the setting, never the value. */
function decodeKey(encoded, setting) {
  const text = String(encoded || '').trim();
  const key = BASE64.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) throw new Error(`[config] ${setting} must be ${KEY_BYTES} bytes, base64-encoded`);
  return key;
}

/** `id:base64,id:base64` → [{ keyId, key }] */
function parsePreviousKeys(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const separator = item.indexOf(':');
    const keyId = separator > 0 ? item.slice(0, separator) : '';
    if (!KEY_ID.test(keyId)) {
      throw new Error('[config] DIAS_REVIEW_STORE_PREVIOUS_KEYS must be a list of id:key pairs separated by commas');
    }
    return { keyId, key: decodeKey(item.slice(separator + 1), `DIAS_REVIEW_STORE_PREVIOUS_KEYS entry '${keyId}'`) };
  });
}

/**
 * The store's cipher from configuration. A missing or malformed key stops
 * start-up with an instruction, instead of reviews failing one by one.
 */
function loadReviewCipher(settings) {
  if (!settings.DIAS_REVIEW_STORE_KEY) {
    throw new Error('[config] DIAS_REVIEW_STORE_KEY is required: the off-chain review store is encrypted. '
      + 'Create a key with node scripts/dias/review-store-key.js and add the two lines it prints to .env');
  }
  if (!KEY_ID.test(settings.DIAS_REVIEW_STORE_KEY_ID || '')) {
    throw new Error('[config] DIAS_REVIEW_STORE_KEY_ID is required and names the key in DIAS_REVIEW_STORE_KEY');
  }
  return createReviewCipher({
    keyId: settings.DIAS_REVIEW_STORE_KEY_ID,
    key: decodeKey(settings.DIAS_REVIEW_STORE_KEY, 'DIAS_REVIEW_STORE_KEY'),
    previousKeys: parsePreviousKeys(settings.DIAS_REVIEW_STORE_PREVIOUS_KEYS),
  });
}

module.exports = {
  ENCRYPTED_REVIEW_SCHEMA_VERSION, createReviewCipher, isEncryptedReview, loadReviewCipher,
};
