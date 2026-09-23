#!/usr/bin/env node
'use strict';

/**
 * Build a stratified training subset for a learning curve or a bounded pilot.
 *
 * Why a subset at all: with the complete policy rendered in every prompt, one
 * epoch of the full 5,254-example training pool is ~10.6M tokens and, at the
 * measured throughput of this machine, roughly a day of wall-clock time. That
 * is a real constraint on how many configurations can be compared, and pouring
 * all of it into a single run assumes more data helps — which is the thing a
 * learning curve is supposed to establish rather than assume.
 *
 * How the subset is chosen: proportionally within strata of
 * (scenario × label × justification kind), so a smaller set keeps the same
 * shape as the full one. Coverage is then repaired — every reason code and
 * every scenario family present in the pool must survive, because a subset that
 * silently drops SEALED_RECORD is not a smaller version of the task, it is a
 * different one.
 *
 * Selection is deterministic from a seed, and nested: the 400-example subset is
 * a subset of the 800-example one, so a learning curve measures the effect of
 * ADDING data rather than the effect of two unrelated samples.
 *
 *   node experiments/dias-finetuning/v2/make-training-subset.js --sizes 400,800,1600
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createRng } = require('./lib/rng');

const DATASET = path.resolve(__dirname, '..', 'data-v2-binary');
const DEFAULT_SIZES = [400, 800, 1600];
const DEFAULT_SEED = 20260912;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next === undefined || next.startsWith('--') ? true : (i += 1, next);
  }
  return args;
}

const stratumOf = (example) =>
  `${example.scenario.split(':')[0]}|${example.label.recommendation}|${example.justificationKind}`;

/**
 * A deterministic priority per example. Ordering by it and taking a prefix gives
 * nested subsets for free: a shorter prefix is always contained in a longer one.
 */
function prioritized(examples, seed) {
  return [...examples]
    .map((example) => ({ example, key: sha256(`${seed}::subset::${example.exampleId}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((entry) => entry.example);
}

/** Proportional allocation across strata, with every stratum guaranteed at least one. */
function allocate(strata, size) {
  const total = [...strata.values()].reduce((sum, items) => sum + items.length, 0);
  const names = [...strata.keys()].sort();
  const quota = new Map(names.map((name) => [name, 1]));
  let remaining = size - names.length;
  if (remaining < 0) {
    // More strata than the requested size: keep the largest strata, one each.
    const ranked = names.sort((a, b) => strata.get(b).length - strata.get(a).length);
    return new Map(ranked.slice(0, size).map((name) => [name, 1]));
  }
  const shares = names.map((name) => ({
    name,
    exact: (strata.get(name).length / total) * size,
  }));
  for (const share of shares) {
    const extra = Math.min(
      Math.max(0, Math.floor(share.exact) - 1),
      strata.get(share.name).length - 1,
      remaining
    );
    quota.set(share.name, 1 + extra);
    remaining -= extra;
  }
  // Hand out what rounding left over, largest-remainder first.
  const byRemainder = shares
    .map((share) => ({ ...share, remainder: share.exact - Math.floor(share.exact) }))
    .sort((a, b) => b.remainder - a.remainder);
  let index = 0;
  while (remaining > 0 && index < byRemainder.length * 4) {
    const share = byRemainder[index % byRemainder.length];
    if (quota.get(share.name) < strata.get(share.name).length) {
      quota.set(share.name, quota.get(share.name) + 1);
      remaining -= 1;
    }
    index += 1;
  }
  return quota;
}

/**
 * Make sure every reason code and scenario in the pool survives, swapping in a
 * missing one for a surplus example from the largest stratum.
 */
function repairCoverage(selected, pool, size) {
  const chosen = new Map(selected.map((example) => [example.exampleId, example]));
  const needed = [];
  for (const key of ['reason_code', 'scenario']) {
    const readKey = key === 'reason_code'
      ? (e) => e.label.reason_code : (e) => e.scenario.split(':')[0];
    const have = new Set([...chosen.values()].map(readKey));
    for (const example of pool) {
      if (!have.has(readKey(example)) && !chosen.has(example.exampleId)) {
        needed.push(example);
        have.add(readKey(example));
      }
    }
  }
  if (needed.length === 0) return [...chosen.values()];
  // Drop from whichever value is most over-represented, so the swap costs least.
  const counts = new Map();
  for (const example of chosen.values()) {
    const key = example.label.reason_code;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const droppable = [...chosen.values()]
    .sort((a, b) => counts.get(b.label.reason_code) - counts.get(a.label.reason_code));
  for (const example of needed) {
    const victim = droppable.shift();
    if (!victim) break;
    chosen.delete(victim.exampleId);
    chosen.set(example.exampleId, example);
  }
  return [...chosen.values()].slice(0, size);
}

function describe(examples) {
  const count = (read) => examples.reduce((acc, example) => {
    const key = read(example);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const allow = examples.filter((e) => e.label.recommendation === 'ALLOW').length;
  return {
    examples: examples.length,
    allow,
    deny: examples.length - allow,
    allowShare: Number((allow / examples.length).toFixed(4)),
    reasonCodes: count((e) => e.label.reason_code),
    scenarios: count((e) => e.scenario.split(':')[0]),
    justificationKinds: count((e) => e.justificationKind),
    families: new Set(examples.map((e) => e.scenarioFamily)).size,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number(args.seed || DEFAULT_SEED);
  const sizes = (args.sizes ? String(args.sizes).split(',') : DEFAULT_SIZES).map(Number)
    .sort((a, b) => a - b);
  const outDir = path.resolve(args.out || path.join(DATASET, 'subsets'));

  const cases = fs.readFileSync(path.join(DATASET, 'train.cases.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const lines = fs.readFileSync(path.join(DATASET, 'train.jsonl'), 'utf8')
    .split('\n').filter(Boolean);
  if (cases.length !== lines.length) {
    throw new Error(`train.jsonl has ${lines.length} lines but train.cases.jsonl has ${cases.length}`);
  }
  const lineFor = new Map(cases.map((example, index) => [example.exampleId, lines[index]]));

  const strata = new Map();
  for (const example of cases) {
    const key = stratumOf(example);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(example);
  }
  const ordered = new Map(
    [...strata.entries()].map(([key, items]) => [key, prioritized(items, seed)])
  );

  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    artifactType: 'dias-v2-training-subsets',
    generatedAtUtc: new Date().toISOString(),
    seed,
    source: path.relative(process.cwd(), path.join(DATASET, 'train.jsonl')),
    sourceExamples: cases.length,
    strata: strata.size,
    method: 'proportional allocation over scenario x label x justification-kind strata, '
      + 'nested by a seeded per-example priority, then coverage-repaired so every '
      + 'reason code and scenario in the pool survives',
    purpose: 'Learning curve / bounded pilot. A subset is NOT a claim that the '
      + 'remaining examples are useless; it is how the training count gets chosen '
      + 'by evidence instead of by assumption.',
    subsets: {},
  };

  let previous = null;
  for (const size of sizes) {
    const quota = allocate(ordered, size);
    const picked = [...quota.entries()].flatMap(([name, take]) => ordered.get(name).slice(0, take));
    const repaired = repairCoverage(picked, cases, size);
    const rng = createRng(seed, `subset-${size}`);
    const shuffled = rng.shuffle(repaired);

    const file = path.join(outDir, `train-${size}.jsonl`);
    fs.writeFileSync(file, `${shuffled.map((e) => lineFor.get(e.exampleId)).join('\n')}\n`);
    fs.writeFileSync(path.join(outDir, `train-${size}.cases.jsonl`),
      `${shuffled.map((e) => JSON.stringify(e)).join('\n')}\n`);

    const ids = new Set(shuffled.map((e) => e.exampleId));
    const nested = previous === null ? null
      : [...previous].filter((id) => !ids.has(id)).length === 0;
    manifest.subsets[size] = {
      ...describe(shuffled),
      file: path.basename(file),
      sha256: sha256(fs.readFileSync(file)),
      nestedInsidePrevious: nested,
    };
    previous = ids;
    const stats = manifest.subsets[size];
    console.log(`train-${String(size).padStart(5)}  ALLOW ${String(stats.allow).padStart(4)}`
      + `  DENY ${String(stats.deny).padStart(4)}`
      + `  reason codes ${Object.keys(stats.reasonCodes).length}`
      + `  scenarios ${Object.keys(stats.scenarios).length}`
      + `  families ${stats.families}`
      + (nested === null ? '' : `  nested: ${nested}`));
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nwritten to ${outDir}`);
}

if (require.main === module) main();
module.exports = { allocate, describe, prioritized, repairCoverage, stratumOf };
