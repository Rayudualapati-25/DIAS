#!/usr/bin/env node
'use strict';

/** The pre-registered plan of the 100-user experiment, run once per model. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { REASONS, generator, shuffled } = require('./plan');
const { digestOf } = require('./setup-plan');
const { officers } = require('./users100');

const HOUR_MS = 60 * 60000;
const REQUESTS_PER_OFFICER_IN_HOUR = 2;
const LOG_READ_EVERY_MS = 30000;
const OUTCOME_READ_DELAY_MS = Object.freeze([5000, 60000]);
const SETUPS = Object.freeze(['mac-only', 'phone-only', 'combined']);
const REPO = path.resolve(__dirname, '..', '..');
/** Requests the written policy answered for each template officer (the oracle on the committed facts). */
const HISTORY = Object.freeze([
  'experiments/runs/20261013_e2e_quiet_ledger/run/rows.jsonl',
  'experiments/runs/20261013_e2e_mac_mobile/run-mac/rows.jsonl',
  'experiments/runs/20261013_e2e_mac_mobile/run-mobile/rows.jsonl',
  'experiments/runs/20261014_mac_mobile_setups/untuned/steps/rows.jsonl',
  'experiments/runs/20261014_mac_mobile_setups/untuned/reuse/rows.jsonl',
]);

/** For each template: the scopes the policy allowed and the ones it denied. */
function knownScopes(files = HISTORY) {
  const known = {};
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (!row.policyAnswer) continue;
      const scope = [row.recordId, row.action, row.purpose].join('|');
      known[row.username] = known[row.username] || { ALLOW: new Set(), DENY: new Set() };
      known[row.username][row.policyAnswer].add(scope);
    }
  }
  return Object.fromEntries(Object.entries(known).map(([user, sets]) => [user,
    { ALLOW: [...sets.ALLOW].sort(), DENY: [...sets.DENY].sort() }]));
}

/** Five distinct scopes per officer: allowed ones first where the template has them. */
function scopesFor(officer, known, random) {
  const table = known[officer.template] || { ALLOW: [], DENY: [] };
  const chosen = [...shuffled(table.ALLOW, random), ...shuffled(table.DENY, random)].slice(0, 5);
  if (chosen.length < 5) throw new Error(`fewer than five known scopes for ${officer.template}`);
  return shuffled(chosen, random).map((scope) => {
    const [recordId, action, purpose] = scope.split('|');
    return { recordId, action, purpose, expected: table.ALLOW.includes(scope) ? 'ALLOW' : 'DENY' };
  });
}

/**
 * Arrival times of a Poisson process that has `count` arrivals in `spanMs`: given the count, its arrival
 * times are independent and uniform over the span.
 */
function poissonTimes(count, spanMs, random) {
  return Array.from({ length: count }, () => Math.round(random() * spanMs)).sort((a, b) => a - b);
}

const request = (id, officer, scope, seat) => ({
  id, username: officer.username, template: officer.template, officer: seat, recordId: scope.recordId,
  action: scope.action, purpose: scope.purpose, expectedPolicy: scope.expected,
  justification: `${REASONS[scope.purpose]} Synthetic 100-user experiment request ${id}.`,
});

function buildPlan100({ seed, known = knownScopes() }) {
  const random = generator(seed);
  const people = officers();
  const scopes = new Map(people.map((officer) => [officer.username, scopesFor(officer, known, random)]));
  // Half the officers use the phone app's calls, half the portal's; the split runs through every template.
  const seatOf = new Map(people.map((officer, index) => [officer.username, index % 2 === 0 ? 'mac' : 'phone']));

  const wanted = shuffled(people.flatMap((officer) => Array.from({ length: REQUESTS_PER_OFFICER_IN_HOUR },
    (_, turn) => ({ officer, turn }))), random);
  const times = poissonTimes(wanted.length, HOUR_MS, random);
  const arrivals = wanted.map(({ officer, turn }, index) => ({
    atMs: times[index],
    outcomeReadAfterMs: Math.round(OUTCOME_READ_DELAY_MS[0] + random() * (OUTCOME_READ_DELAY_MS[1] - OUTCOME_READ_DELAY_MS[0])),
    ...request(`H-${String(index + 1).padStart(3, '0')}`, officer, scopes.get(officer.username)[turn], seatOf.get(officer.username)),
  }));
  const logReads = Array.from({ length: HOUR_MS / LOG_READ_EVERY_MS }, (_, index) => {
    const officer = people[Math.floor(random() * people.length)];
    return { atMs: (index + 1) * LOG_READ_EVERY_MS - Math.round(random() * 5000), username: officer.username,
      officer: seatOf.get(officer.username) };
  });
  const hour = { spanMs: HOUR_MS, arrivals, logReads };

  const bursts = shuffled(SETUPS, random).map((setup, index) => ({
    id: `L100-${setup}`, setup, level: people.length, repeat: 1,
    requests: people.map((officer, number) => request(`L100-${setup}-${String(number + 1).padStart(3, '0')}`, officer,
      scopes.get(officer.username)[REQUESTS_PER_OFFICER_IN_HOUR + SETUPS.indexOf(setup)],
      setup === 'mac-only' ? 'mac' : setup === 'phone-only' ? 'phone' : (number % 2 === 0 ? 'mac' : 'phone'))),
    order: index,
  }));
  const load = { levels: [people.length], repeats: 1, bursts, order: bursts.map((burst) => burst.id) };
  const steps = { perCell: 0, items: [], order: [] };
  const reuse = { basesPerCell: 0, repeatsPerBase: 0, bases: [], order: [] };
  const hourSha256 = crypto.createHash('sha256').update(JSON.stringify({ seed, hour })).digest('hex');
  return {
    schema: 'dias-100-user-plan-v1', seed, auditor: 'sp.north', officers: people.length, history: HISTORY,
    steps, reuse, load, hour, hourSha256, sha256: digestOf({ seed, steps, reuse, load }),
  };
}

const hourDigestOf = ({ seed, hour }) => crypto.createHash('sha256').update(JSON.stringify({ seed, hour })).digest('hex');

module.exports = { HOUR_MS, buildPlan100, hourDigestOf, knownScopes, poissonTimes, scopesFor };

if (require.main === module) {
  const [seed, out] = process.argv.slice(2);
  const plan = buildPlan100({ seed: Number(seed) });
  fs.writeFileSync(out, `${JSON.stringify(plan, null, 1)}\n`);
  const all = [...plan.hour.arrivals, ...plan.load.bursts.flatMap((burst) => burst.requests)];
  const allowed = all.filter((item) => item.expectedPolicy === 'ALLOW').length;
  console.log(`${plan.officers} officers; hour: ${plan.hour.arrivals.length} requests, ${plan.hour.logReads.length} log reads; `
    + `${plan.load.bursts.length} bursts of ${plan.officers}; ${allowed} of ${all.length} requests allowed by the policy history; `
    + `sha256 ${plan.sha256}, hour ${plan.hourSha256} -> ${out}`);
}
