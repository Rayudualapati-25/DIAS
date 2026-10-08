'use strict';

/**
 * The off-chain review store at rest (design §10, plan step 13).
 *
 * The justification, the recommendation object and the auditor's note are written
 * encrypted: AES-256-GCM, a fresh IV per write, and the request identifier bound
 * in as authenticated data so a file moved to another request does not open. The
 * ledger's digests already make the content tamper-evident; this keeps copies and
 * backups of the store unreadable without the key.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

const { createReviewStore } = require('../src/dias/reviewStore');
const {
  ENCRYPTED_REVIEW_SCHEMA_VERSION, createReviewCipher, loadReviewCipher,
} = require('../src/dias/reviewCipher');
const { committedRequest } = require('./fixtures/decisionFixtures');

const JUSTIFICATION = 'Reviewing the FIR for the sealed juvenile matter.';
const newKey = () => crypto.randomBytes(32);
const cipherWith = (keyId, key, previousKeys = []) => createReviewCipher({ keyId, key, previousKeys });
const silent = Object.freeze({ log() {}, error() {} });

describe('off-chain review store encryption', () => {
  let dir;
  let key;
  let store;
  const fileOf = (requestId) => path.join(dir, `${requestId}.json`);
  const onDisk = (requestId) => fs.readFileSync(fileOf(requestId), 'utf8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-encrypted-'));
    key = newKey();
    store = createReviewStore(dir, { cipher: cipherWith('k1', key), log: silent });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes nothing readable and reads back exactly what was stored', () => {
    const created = store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const raw = onDisk('REQ-1');
    expect(raw).to.not.include('Reviewing');
    expect(raw).to.not.include('insp.test');
    const envelope = JSON.parse(raw);
    expect(Object.keys(envelope).sort()).to.deep.equal(['ciphertext', 'iv', 'keyId', 'requestId', 'schemaVersion', 'tag']);
    expect(envelope).to.include({ schemaVersion: ENCRYPTED_REVIEW_SCHEMA_VERSION, requestId: 'REQ-1', keyId: 'k1' });
    expect(Buffer.from(envelope.iv, 'base64')).to.have.length(12);
    expect(store.read('REQ-1')).to.deep.equal(created);
  });

  it('uses a fresh IV for every write, so the same entry never encrypts the same way twice', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const first = JSON.parse(onDisk('REQ-1'));
    store.update('REQ-1', {});
    const second = JSON.parse(onDisk('REQ-1'));
    expect(second.iv).to.not.equal(first.iv);
    expect(second.ciphertext).to.not.equal(first.ciphertext);
  });

  it('does not open with another key', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const other = createReviewStore(dir, { cipher: cipherWith('k1', newKey()), log: silent });
    expect(() => other.read('REQ-1')).to.throw(/could not be decrypted/);
    const unknown = createReviewStore(dir, { cipher: cipherWith('k2', key), log: silent });
    expect(() => unknown.read('REQ-1')).to.throw(/no key 'k1'/);
  });

  it('does not open after its ciphertext, IV or tag was changed', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const envelope = JSON.parse(onDisk('REQ-1'));
    const flipped = (base64) => {
      const bytes = Buffer.from(base64, 'base64');
      bytes[0] ^= 0x01;
      return bytes.toString('base64');
    };
    for (const field of ['ciphertext', 'iv', 'tag']) {
      fs.writeFileSync(fileOf('REQ-1'), JSON.stringify({ ...envelope, [field]: flipped(envelope[field]) }));
      expect(() => store.read('REQ-1'), field).to.throw(/could not be decrypted/);
    }
  });

  it('does not open a file that was moved to another request', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    fs.copyFileSync(fileOf('REQ-1'), fileOf('REQ-2'));
    expect(() => store.read('REQ-2')).to.throw(/belongs to request 'REQ-1'/);
    // Even with the identifier inside the file rewritten, the binding does not verify.
    fs.writeFileSync(fileOf('REQ-2'), JSON.stringify({ ...JSON.parse(onDisk('REQ-1')), requestId: 'REQ-2' }));
    expect(() => store.read('REQ-2')).to.throw(/could not be decrypted/);
  });

  it('opens entries written under an earlier key, and writes with the current one', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const rotated = createReviewStore(dir, {
      cipher: cipherWith('k2', newKey(), [{ keyId: 'k1', key }]), log: silent,
    });
    expect(rotated.read('REQ-1').justification).to.equal(JUSTIFICATION);
    rotated.update('REQ-1', { recommendationState: 'committed' });
    expect(JSON.parse(onDisk('REQ-1')).keyId).to.equal('k2');
  });

  it('encrypts an entry written before encryption at start-up, and refuses it in the clear after that', () => {
    const plain = createReviewStore(dir, { log: silent });
    plain.create({ request: committedRequest('REQ-OLD'), justification: JUSTIFICATION });
    store.create({ request: committedRequest('REQ-NEW'), justification: JUSTIFICATION });
    expect(onDisk('REQ-OLD')).to.include('Reviewing');
    // An encrypted store does not take a file in the clear at face value.
    expect(() => store.read('REQ-OLD')).to.throw(/is not encrypted/);

    expect(store.sealWithCurrentKey()).to.deep.equal({ encrypted: 1, resealed: 0, unreadable: 0 });
    expect(onDisk('REQ-OLD')).to.not.include('Reviewing');
    expect(store.read('REQ-OLD').justification).to.equal(JUSTIFICATION);
    expect(store.sealWithCurrentKey()).to.deep.equal({ encrypted: 0, resealed: 0, unreadable: 0 });
  });

  it('re-seals entries of an earlier key at start-up, so that key can be retired', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const rotated = createReviewStore(dir, {
      cipher: cipherWith('k2', newKey(), [{ keyId: 'k1', key }]), log: silent,
    });
    expect(rotated.sealWithCurrentKey()).to.deep.equal({ encrypted: 0, resealed: 1, unreadable: 0 });
    expect(JSON.parse(onDisk('REQ-1')).keyId).to.equal('k2');
    expect(rotated.read('REQ-1').justification).to.equal(JUSTIFICATION);
  });

  it('counts what it cannot open at start-up and leaves it untouched', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const before = onDisk('REQ-1');
    const errors = [];
    const stranger = createReviewStore(dir, {
      cipher: cipherWith('k9', newKey()), log: { error: (message) => errors.push(message) },
    });
    expect(stranger.sealWithCurrentKey()).to.deep.equal({ encrypted: 0, resealed: 0, unreadable: 1 });
    expect(onDisk('REQ-1')).to.equal(before);
    expect(errors[0]).to.match(/REQ-1\.json/);
  });

  it('reads safely for a list: an entry that cannot be opened is reported and treated as absent', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const errors = [];
    const stranger = createReviewStore(dir, {
      cipher: cipherWith('k9', newKey()), log: { error: (message) => errors.push(message) },
    });
    expect(stranger.readSafely('REQ-1')).to.equal(null);
    expect(errors[0]).to.match(/REQ-1/);
    expect(store.readSafely('REQ-1').justification).to.equal(JUSTIFICATION);
    expect(store.readSafely('REQ-404')).to.equal(null);
    expect(() => store.readSafely('../escape')).to.throw(/invalid format/);
  });

  it('does not open with a shortened authentication tag', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const envelope = JSON.parse(onDisk('REQ-1'));
    const shortTag = Buffer.from(envelope.tag, 'base64').subarray(0, 4).toString('base64');
    fs.writeFileSync(fileOf('REQ-1'), JSON.stringify({ ...envelope, tag: shortTag }));
    expect(() => store.read('REQ-1')).to.throw(/could not be decrypted/);
  });

  it('refuses to read an encrypted entry without a key, and skips it when listing', () => {
    store.create({ request: committedRequest('REQ-1'), justification: JUSTIFICATION });
    const skipped = [];
    const keyless = createReviewStore(dir, { log: { error: (message) => skipped.push(message) } });
    expect(() => keyless.read('REQ-1')).to.throw(/is encrypted and this store has no key/);
    expect(keyless.list()).to.deep.equal([]);
    expect(skipped[0]).to.match(/REQ-1\.json/);
  });

  describe('the key from configuration', () => {
    const settings = (overrides = {}) => ({
      DIAS_REVIEW_STORE_KEY: key.toString('base64'), DIAS_REVIEW_STORE_KEY_ID: 'k1',
      DIAS_REVIEW_STORE_PREVIOUS_KEYS: '', ...overrides,
    });

    it('builds a cipher from a 32-byte base64 key, its identifier and earlier keys', () => {
      const earlier = newKey();
      const loaded = loadReviewCipher(settings({
        DIAS_REVIEW_STORE_KEY_ID: 'k2', DIAS_REVIEW_STORE_PREVIOUS_KEYS: `k1:${earlier.toString('base64')}`,
      }));
      expect(loaded.keyId).to.equal('k2');
      const sealedEarlier = cipherWith('k1', earlier).seal('REQ-1', { requestId: 'REQ-1', value: 1 });
      expect(loaded.open('REQ-1', sealedEarlier)).to.deep.equal({ requestId: 'REQ-1', value: 1 });
    });

    it('stops start-up without a key, naming how to create one, and never echoes key material', () => {
      expect(() => loadReviewCipher(settings({ DIAS_REVIEW_STORE_KEY: '' })))
        .to.throw(/DIAS_REVIEW_STORE_KEY is required.*scripts\/dias\/review-store-key\.js/);
      expect(() => loadReviewCipher(settings({ DIAS_REVIEW_STORE_KEY_ID: '' })))
        .to.throw(/DIAS_REVIEW_STORE_KEY_ID/);
      const short = crypto.randomBytes(16).toString('base64');
      let message = '';
      try {
        loadReviewCipher(settings({ DIAS_REVIEW_STORE_KEY: short }));
      } catch (error) {
        message = error.message;
      }
      expect(message).to.match(/must be 32 bytes, base64-encoded/);
      expect(message).to.not.include(short);
      expect(() => loadReviewCipher(settings({ DIAS_REVIEW_STORE_PREVIOUS_KEYS: 'k0:not-a-key' })))
        .to.throw(/DIAS_REVIEW_STORE_PREVIOUS_KEYS.*'k0'/);
      expect(() => loadReviewCipher(settings({ DIAS_REVIEW_STORE_PREVIOUS_KEYS: `k1:${key.toString('base64')}` })))
        .to.throw(/key identifier 'k1' is used twice/);
    });
  });
});
