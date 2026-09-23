'use strict';

/**
 * Storage determinism.
 *
 * Fabric compares endorsers' write sets byte for byte. JSON.stringify preserves
 * insertion order, so two peers that read a stored value whose keys are ordered
 * differently produce different bytes for a logically identical update, and
 * every later write to that key fails endorsement with "ProposalResponsePayloads
 * do not match". The peer log named it exactly: same key set, different key
 * order, "write value mismatch".
 *
 * These tests pin both halves of the fix: the serializer is order-independent,
 * and no contract may write JSON to state without it.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const { serializeState, putJson } = require('../lib/util/state');

const LIB = path.resolve(__dirname, '..', 'lib');
const CONTRACTS = fs.readdirSync(LIB).filter((f) => f.endsWith('Contract.js'));

describe('canonical ledger state', () => {
  describe('the serializer is independent of insertion order', () => {
    it('produces identical bytes for the same content inserted in any order', () => {
      // Exactly the shape that failed on the live network: one peer had read a
      // value where decisionId came early, another where it had been appended.
      const asDecided = {
        docType: 'accessRequest',
        requestId: 'req-1',
        recordId: 'FIR-1',
        status: 'pending-escalation',
        txId: 'tx-1',
        decisionId: 'dec-1',
      };
      const asResolved = {
        docType: 'accessRequest',
        decisionId: 'dec-1',
        requestId: 'req-1',
        recordId: 'FIR-1',
        status: 'pending-escalation',
        txId: 'tx-1',
      };

      expect(Object.keys(asDecided)).to.not.deep.equal(Object.keys(asResolved));
      expect(JSON.stringify(asDecided)).to.not.equal(JSON.stringify(asResolved));
      expect(serializeState(asDecided).equals(serializeState(asResolved))).to.equal(true);
    });

    it('survives the spread that caused the divergence', () => {
      const stored = { a: 1, b: 2, c: 3 };
      const appended = { ...stored, d: 4 };
      const reordered = { d: 4, c: 3, b: 2, a: 1 };
      expect(serializeState(appended).equals(serializeState(reordered))).to.equal(true);
    });

    it('canonicalises nested objects and preserves array order', () => {
      const left = { outer: { z: 1, a: [3, 1, 2] }, top: true };
      const right = { top: true, outer: { a: [3, 1, 2], z: 1 } };
      expect(serializeState(left).equals(serializeState(right))).to.equal(true);
      // Array order is data, not key order, and must be preserved.
      expect(serializeState({ a: [1, 2] }).equals(serializeState({ a: [2, 1] }))).to.equal(false);
    });

    it('still distinguishes different content', () => {
      expect(serializeState({ a: 1 }).equals(serializeState({ a: 2 }))).to.equal(false);
      expect(serializeState({ a: 1 }).equals(serializeState({ a: 1, b: 2 }))).to.equal(false);
    });

    it('refuses anything that is not a JSON object', () => {
      [null, 'text', 42, ['a'], undefined].forEach((bad) => {
        expect(() => serializeState(bad)).to.throw(/must be a JSON object/);
      });
    });

    it('writes the canonical bytes through putJson', async () => {
      let written = null;
      const ctx = { stub: { putState: async (k, v) => { written = { k, v }; } } };
      await putJson(ctx, 'k1', { b: 2, a: 1 });
      expect(written.k).to.equal('k1');
      expect(written.v.toString('utf8')).to.equal('{"a":1,"b":2}');
    });
  });

  describe('no contract may bypass the serializer', () => {
    CONTRACTS.forEach((file) => {
      it(`${file} writes JSON state only through putJson`, () => {
        const source = fs.readFileSync(path.join(LIB, file), 'utf8');
        const rawWrites = (source.match(/ctx\.stub\.putState\s*\(/g) || []).length;
        expect(
          rawWrites,
          `${file} calls ctx.stub.putState directly. Use putJson(ctx, key, object) `
          + 'so the stored bytes are a function of content, not insertion order.'
        ).to.equal(0);
      });

      it(`${file} never serialises STATE with JSON.stringify`, () => {
        const source = fs.readFileSync(path.join(LIB, file), 'utf8');
        // JSON.stringify is still correct for two things and only two:
        //   - transaction return values, which the contract API requires;
        //   - setEvent payloads, which are fixed object literals in source, so
        //     their key order is identical on every peer (verified: no event
        //     payload is built by spreading a value read from state).
        // What must never happen is JSON.stringify reaching putState.
        const stateWrite = /putState\s*\([^;]*JSON\.stringify/.test(source);
        expect(
          stateWrite,
          `${file} serialises ledger state with JSON.stringify, which preserves insertion order`
        ).to.equal(false);
      });

      it(`${file} builds no event payload from spread state`, () => {
        const source = fs.readFileSync(path.join(LIB, file), 'utf8');
        // An event payload IS part of the proposal response, so if one were ever
        // built by spreading a stored object it would diverge the same way.
        const events = source.match(/setEvent\([^;]*?\)\);/gs) || [];
        events.forEach((e) => {
          expect(/\.\.\./.test(e), `${file} spreads state into an event payload`)
            .to.equal(false);
        });
      });
    });

    it('every contract imports the shared writer', () => {
      CONTRACTS.forEach((file) => {
        const source = fs.readFileSync(path.join(LIB, file), 'utf8');
        if (!/putJson\s*\(/.test(source)) return; // a contract that writes nothing is fine
        expect(source, `${file} uses putJson without importing it`)
          .to.contain("require('./util/state')");
      });
    });
  });
});
