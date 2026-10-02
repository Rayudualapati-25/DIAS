'use strict';

/**
 * dias-commitment-hash-v1 (docs/design/dias-v3-ledger-schema.md §4): strict
 * canonical JSON and domain-separated SHA-256. The vectors are shared with the
 * backend and frontend tests; some digests were computed with the shell, so a
 * bug shared by every JavaScript implementation would still be caught.
 */

const { expect } = require('chai');
const vectors = require('./fixtures/commitment-vectors.json');
const {
  DOMAINS, HASH_FORMAT_VERSION, assertDigest, canonicalJson, hashCanonical, hashText, isDigest,
} = require('../lib/dias/commitments');

describe('commitment hashing (dias-commitment-hash-v1)', () => {
  it('declares its format and the six domains of the design', () => {
    expect(HASH_FORMAT_VERSION).to.equal(vectors.format);
    expect(Object.values(DOMAINS)).to.have.members([
      'context', 'claims', 'justification', 'recommendation', 'note', 'policy',
    ]);
  });

  describe('canonical JSON', () => {
    for (const { value, canonical, why } of vectors.canonical) {
      it(`serializes ${JSON.stringify(value)}${why ? ` (${why})` : ''}`, () => {
        expect(canonicalJson(value)).to.equal(canonical);
      });
    }

    it('is independent of insertion order at every depth', () => {
      const left = { b: { y: [1, { d: 2, c: 3 }], x: null }, a: 'z' };
      const right = { a: 'z', b: { x: null, y: [1, { c: 3, d: 2 }] } };
      expect(canonicalJson(left)).to.equal(canonicalJson(right));
    });

    for (const { value, why } of vectors.rejected) {
      it(`rejects ${why}`, () => {
        expect(() => canonicalJson(value)).to.throw(/canonical JSON/);
      });
    }

    it('rejects values JSON cannot represent exactly', () => {
      for (const bad of [undefined, NaN, Infinity, -Infinity, () => 1, Symbol('s'), new Date(0),
        new Map(), { a: undefined }, [1, undefined]]) {
        expect(() => canonicalJson(bad), String(bad)).to.throw(/canonical JSON/);
      }
    });

    it('rejects strings with an unpaired surrogate anywhere, including keys', () => {
      expect(() => canonicalJson('\ud800')).to.throw(/unpaired surrogate/);
      expect(() => canonicalJson({ ['a\udc00']: 1 })).to.throw(/unpaired surrogate/);
      expect(() => canonicalJson(['ok', 'x\ud83d'])).to.throw(/unpaired surrogate/);
      expect(canonicalJson('😀')).to.equal('"😀"');
    });
  });

  describe('domain-separated digests', () => {
    for (const { domain, text, digest } of vectors.text) {
      it(`hashes ${domain} text ${JSON.stringify(text)} to the shell reference`, () => {
        expect(hashText(domain, text)).to.equal(digest);
      });
    }

    for (const { domain, value, digest } of vectors.json) {
      it(`hashes canonical ${domain} JSON to the shell reference`, () => {
        expect(hashCanonical(domain, value)).to.equal(digest);
      });
    }

    it('gives the same text different digests in different domains', () => {
      expect(hashText('note', 'hello')).to.not.equal(hashText('justification', 'hello'));
    });

    it('hashes text exactly: no trimming and no Unicode normalization', () => {
      expect(hashText('note', 'hello')).to.not.equal(hashText('note', 'hello '));
      expect(hashText('note', 'café')).to.not.equal(hashText('note', 'café'));
    });

    it('detects any change to structured content', () => {
      const base = { requester: { role: 'inspector' }, request: { action: 'view' } };
      const changed = { requester: { role: 'inspector' }, request: { action: 'export' } };
      expect(hashCanonical('context', base)).to.not.equal(hashCanonical('context', changed));
    });

    it('refuses an unknown domain and non-string text', () => {
      expect(() => hashText('comment', 'x')).to.throw(/unknown commitment domain/);
      expect(() => hashCanonical('context2', {})).to.throw(/unknown commitment domain/);
      expect(() => hashText('note', 42)).to.throw(/must be a string/);
      expect(() => hashText('note', '\ud800')).to.throw(/unpaired surrogate/);
    });
  });

  describe('digest format', () => {
    it('accepts exactly 64 lowercase hexadecimal characters', () => {
      expect(isDigest('a'.repeat(64))).to.equal(true);
      for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `sha256:${'a'.repeat(64)}`,
        'g'.repeat(64), '', null, undefined, 42]) {
        expect(isDigest(bad), String(bad)).to.equal(false);
      }
    });

    it('names the field when a digest is malformed', () => {
      expect(() => assertDigest('xyz', 'noteHash')).to.throw(/noteHash must be a SHA-256 digest/);
      expect(() => assertDigest('b'.repeat(64), 'noteHash')).to.not.throw();
    });
  });
});
