'use strict';

/**
 * Deterministic pseudo-randomness for dataset generation.
 *
 * Every draw must be reproducible from a recorded seed, so `Math.random` is
 * never used. Streams are named: `rng.stream('justification')` gives an
 * independent sequence derived from the master seed and that name, so adding a
 * draw in one part of the generator does not shift every later draw elsewhere.
 * Without that, a one-line change silently regenerates the whole dataset.
 */

const crypto = require('crypto');

/** xoshiro128** — small, fast, and good enough for sampling synthetic records. */
function createGenerator(seedBytes) {
  const state = new Uint32Array(4);
  for (let i = 0; i < 4; i += 1) state[i] = seedBytes.readUInt32LE(i * 4) || (i + 1);
  const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
  return () => {
    const result = (Math.imul(rotl(Math.imul(state[1], 5) >>> 0, 7), 9) >>> 0);
    const t = (state[1] << 9) >>> 0;
    state[2] = (state[2] ^ state[0]) >>> 0;
    state[3] = (state[3] ^ state[1]) >>> 0;
    state[1] = (state[1] ^ state[2]) >>> 0;
    state[0] = (state[0] ^ state[3]) >>> 0;
    state[2] = (state[2] ^ t) >>> 0;
    state[3] = rotl(state[3], 11);
    return result / 4294967296;
  };
}

function createRng(seed, label = 'root') {
  const next = createGenerator(
    crypto.createHash('sha256').update(`${seed}::${label}`).digest()
  );

  const api = {
    seed,
    label,
    next,
    /** Integer in [min, max]. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(probability = 0.5) {
      return next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new Error(`cannot pick from an empty list (${label})`);
      return items[Math.floor(next() * items.length)];
    },
    /** A new array, shuffled. The input is never mutated. */
    shuffle(items) {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    /** `count` distinct items, or all of them when the list is shorter. */
    sample(items, count) {
      return api.shuffle(items).slice(0, Math.min(count, items.length));
    },
    /** An independent stream, so unrelated draws cannot disturb each other. */
    stream(name) {
      return createRng(seed, `${label}/${name}`);
    },
  };
  return api;
}

module.exports = { createRng };
