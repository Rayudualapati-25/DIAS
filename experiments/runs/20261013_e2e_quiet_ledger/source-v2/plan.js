'use strict';

/**
 * The pre-registered request plan of the end-to-end experiment.
 *
 * Two halves of equal size and equal mix: one for the Mac application alone, one
 * for the Mac and the phone together. Every request scope (requester, case file,
 * action, purpose) is used once across both halves and every justification is
 * different, so no request can be answered from an earlier one: not by a
 * reusable authorization and not by the model server's prompt cache.
 *
 * The plan is a pure function of its seed. Its digest is written with it, so a
 * run can show which plan it followed.
 */

const crypto = require('crypto');

/** Officers who can raise a request on the Mac host; auditors are not requesters here. */
const REQUESTERS = Object.freeze([
  { username: 'const.verma', org: 'police', role: 'constable' },
  { username: 'insp.rathore', org: 'police', role: 'inspector' },
  { username: 'insp.sharma', org: 'police', role: 'inspector' },
  { username: 'insp.singh', org: 'police', role: 'inspector' },
  { username: 'io.krishnan', org: 'police', role: 'investigating-officer' },
  { username: 'sho.reddy', org: 'police', role: 'inspector' },
  { username: 'analyst.rao', org: 'forensics', role: 'lab-analyst' },
  { username: 'dir.iyer', org: 'forensics', role: 'lab-director' },
  { username: 'dc.nair', org: 'prosecution', role: 'defense-counsel' },
  { username: 'pp.mehta', org: 'prosecution', role: 'public-prosecutor' },
  { username: 'clerk.das', org: 'court', role: 'court-clerk' },
  { username: 'judge.rana', org: 'court', role: 'judge' },
]);
const RECORDS = Object.freeze(['REC-FIR-001', 'REC-EVIDENCE-001', 'REC-JUVENILE-001']);
const ACTIONS = Object.freeze(['view', 'export', 'annotate']);
const PURPOSES = Object.freeze([
  'investigation', 'forensic-analysis', 'prosecution', 'judicial-proceeding', 'audit-review',
  'defense-preparation',
]);
const CONFIGS = Object.freeze([{ config: 'mac', tag: 'MAC' }, { config: 'mobile', tag: 'MOB' }]);

/** A neutral reason per purpose: it states the purpose and claims no role or assignment. */
const REASONS = Object.freeze({
  investigation: 'Needed for the ongoing investigation of this case.',
  'forensic-analysis': 'Needed for forensic analysis of the case material.',
  prosecution: 'Needed to prepare the prosecution of this case.',
  'judicial-proceeding': 'Needed for a judicial proceeding in this case.',
  'audit-review': 'Needed for an audit review of how this case was handled.',
  'defense-preparation': 'Needed to prepare the defence in this case.',
});

/** mulberry32: a small seeded generator, so the plan never depends on Math.random. */
function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/**
 * `count` values that cycle through `values`, in a seeded order. The values are
 * shuffled before they are cycled, so a count smaller than the list does not
 * always pick the list's first entries.
 */
function spread(values, count, random) {
  const base = shuffled(values, random);
  return shuffled(Array.from({ length: count }, (_, index) => base[index % base.length]), random);
}

const scopeOf = (item) => [item.username, item.recordId, item.action, item.purpose].join('|');

/** One half: every attribute as evenly spread as its count allows, no scope in `taken`. */
function half(perConfig, random, taken) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const users = spread(REQUESTERS.map((requester) => requester.username), perConfig, random);
    const records = spread(RECORDS, perConfig, random);
    const actions = spread(ACTIONS, perConfig, random);
    const purposes = spread(PURPOSES, perConfig, random);
    const items = users.map((username, index) => ({
      username, recordId: records[index], action: actions[index], purpose: purposes[index],
    }));
    const scopes = items.map(scopeOf);
    if (new Set(scopes).size === scopes.length && scopes.every((scope) => !taken.has(scope))) return items;
  }
  throw new Error('could not draw distinct request scopes for this plan');
}

/** The digest that identifies a plan: its seed, size, requests and running order. */
const digestOf = ({ seed, perConfig, items, order }) =>
  crypto.createHash('sha256').update(JSON.stringify({ seed, perConfig, items, order })).digest('hex');

/**
 * The running order: the two halves alternate, and a seeded coin decides which
 * of each pair goes first. Both halves then meet the same ledger size and the
 * same background conditions, and neither always runs first.
 */
function interleaved(items, random) {
  const [first, second] = CONFIGS.map(({ config }) => items.filter((item) => item.config === config));
  return first.flatMap((item, index) => (random() < 0.5 ? [item.id, second[index].id] : [second[index].id, item.id]));
}

/**
 * `prefix` names the plan in every request id and justification, so a later plan
 * never repeats an earlier prompt. `exclude` lists request scopes already used
 * (as "username|recordId|action|purpose") that this plan must not use again.
 */
function buildPlan({ seed, perConfig, prefix = 'E2E', exclude = [] }) {
  const available = REQUESTERS.length * RECORDS.length * ACTIONS.length * PURPOSES.length - new Set(exclude).size;
  if (!Number.isInteger(perConfig) || perConfig < 1 || perConfig * CONFIGS.length > available) {
    throw new Error(`a plan needs 1 to ${Math.floor(available / CONFIGS.length)} distinct requests per configuration`);
  }
  const random = generator(seed);
  const taken = new Set(exclude);
  const items = [];
  for (const { config, tag } of CONFIGS) {
    half(perConfig, random, taken).forEach((scope, index) => {
      taken.add(scopeOf(scope));
      const id = `${prefix}-${tag}-${String(index + 1).padStart(2, '0')}`;
      items.push({
        id, config, ...scope,
        justification: `${REASONS[scope.purpose]} Synthetic end-to-end experiment request ${id}.`,
      });
    });
  }
  const order = interleaved(items, random);
  const plan = { seed, perConfig, items, order };
  return { schema: 'dias-e2e-plan-v2', seed, perConfig, prefix, auditor: 'sp.north', items, order, sha256: digestOf(plan) };
}

module.exports = { ACTIONS, PURPOSES, RECORDS, REQUESTERS, buildPlan, digestOf, scopeOf };

// usage: plan.js SEED PER_CONFIG OUT [PREFIX] [EARLIER_PLAN.json ...]
if (require.main === module) {
  const fs = require('fs');
  const [seed, perConfig, out, prefix, ...earlier] = process.argv.slice(2);
  const exclude = earlier.flatMap((file) => JSON.parse(fs.readFileSync(file, 'utf8')).items.map(scopeOf));
  const plan = buildPlan({ seed: Number(seed), perConfig: Number(perConfig), prefix: prefix || 'E2E', exclude });
  fs.writeFileSync(out, `${JSON.stringify({ ...plan, excludedScopes: exclude.length }, null, 1)}\n`);
  console.log(`${plan.items.length} requests, ${exclude.length} earlier scopes avoided, sha256 ${plan.sha256} -> ${out}`);
}
