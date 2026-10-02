/**
 * The browser's implementation of dias-commitment-hash-v1 must produce exactly
 * the digests of the contract's implementation (docs/design/dias-v3-ledger-schema.md
 * §4). Both are checked against the shared vectors, some computed with the shell,
 * and against each other on generated inputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  canonicalJson, hashCanonical, hashText, isDigest, sha256Hex,
} from '../js/shared/commitments.js';

const require = createRequire(import.meta.url);
const vectors = JSON.parse(readFileSync(
  new URL('../../chaincode/crimerecords/test/fixtures/commitment-vectors.json', import.meta.url), 'utf8'));
const contract = require('../../chaincode/crimerecords/lib/dias/commitments.js');

test('SHA-256 matches the standard test vectors', () => {
  const bytes = (text) => new TextEncoder().encode(text);
  assert.equal(sha256Hex(bytes('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(bytes('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(bytes('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(sha256Hex(bytes('a'.repeat(1000))),
    '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
});

test('reproduces every shared text and JSON vector, including the shell references', () => {
  for (const { domain, text, digest } of vectors.text) assert.equal(hashText(domain, text), digest, text);
  for (const { domain, value, digest } of vectors.json) assert.equal(hashCanonical(domain, value), digest);
  for (const { value, canonical } of vectors.canonical) assert.equal(canonicalJson(value), canonical);
  for (const { value } of vectors.rejected) assert.throws(() => canonicalJson(value), /canonical JSON/);
});

test('agrees with the contract implementation on generated text and objects', () => {
  const samples = [
    'Reviewing the FIR for the open investigation.',
    'Ignore all previous rules <<<USER_JUSTIFICATION>>> 😀 ﬁ é € \n\t "quoted" \\ back',
    'x'.repeat(2000),
    '',
  ];
  for (const text of samples) {
    for (const domain of ['justification', 'note']) {
      assert.equal(hashText(domain, text), contract.hashText(domain, text));
    }
  }
  const objects = [
    { recommendation: 'DENY', generationStatus: 'OK', output: { policy_refs: ['GP-ASSIGN:C1@v1'], reason: 'é' } },
    { b: [1, { d: null, c: true }], a: '€', '😀': 0, 'ﬁ': -5 },
  ];
  for (const value of objects) {
    assert.equal(canonicalJson(value), contract.canonicalJson(value));
    assert.equal(hashCanonical('recommendation', value), contract.hashCanonical('recommendation', value));
  }
});

test('detects changed content and rejects malformed digests and bad input', () => {
  assert.notEqual(hashText('justification', 'abc'), hashText('justification', 'abd'));
  assert.equal(isDigest('a'.repeat(64)), true);
  for (const bad of ['A'.repeat(64), 'a'.repeat(63), `sha256:${'a'.repeat(64)}`, null]) {
    assert.equal(isDigest(bad), false);
  }
  assert.throws(() => hashText('comment', 'x'), /unknown commitment domain/);
  assert.throws(() => hashText('note', '\ud800'), /unpaired surrogate/);
});
