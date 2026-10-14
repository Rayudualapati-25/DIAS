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

/** `count` values that cycle through `values`, in a seeded order. */
const spread = (values, count, random) =>
  shuffled(Array.from({ length: count }, (_, index) => values[index % values.length]), random);

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

function buildPlan({ seed, perConfig }) {
  const available = REQUESTERS.length * RECORDS.length * ACTIONS.length * PURPOSES.length;
  if (!Number.isInteger(perConfig) || perConfig < 1 || perConfig * CONFIGS.length > available) {
    throw new Error(`a plan needs 1 to ${Math.floor(available / CONFIGS.length)} distinct requests per configuration`);
  }
  const random = generator(seed);
  const taken = new Set();
  const items = [];
  for (const { config, tag } of CONFIGS) {
    half(perConfig, random, taken).forEach((scope, index) => {
      taken.add(scopeOf(scope));
      const id = `E2E-${tag}-${String(index + 1).padStart(2, '0')}`;
      items.push({
        id, config, ...scope,
        justification: `${REASONS[scope.purpose]} Synthetic end-to-end experiment request ${id}.`,
      });
    });
  }
  const sha256 = crypto.createHash('sha256').update(JSON.stringify({ seed, perConfig, items })).digest('hex');
  return { schema: 'dias-e2e-plan-v1', seed, perConfig, auditor: 'sp.north', items, sha256 };
}

module.exports = { ACTIONS, PURPOSES, RECORDS, REQUESTERS, buildPlan };

if (require.main === module) {
  const [seed, perConfig, out] = process.argv.slice(2);
  const plan = buildPlan({ seed: Number(seed), perConfig: Number(perConfig) });
  require('fs').writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
  console.log(`${plan.items.length} requests, sha256 ${plan.sha256} -> ${out}`);
}
