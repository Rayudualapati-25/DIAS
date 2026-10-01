#!/usr/bin/env node
'use strict';

/**
 * E7 plan: twelve minutes of random (Poisson) arrivals at six per minute, used
 * while one orderer and then one peer are stopped and restarted.
 *
 * Court users are left out: their own peer (peer0.court) is the one stopped, and
 * a user reaches the ledger only through their own organization's peer. The
 * seed differs from the E5/E6 plans, which stay unchanged.
 *
 * Usage: node testbed/load/fault-plan.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadBundle } = require('../../policies/lib/bundle');
const world = require('../seed/world');
const { buildUsers, combinationsFor, rng, shuffle } = require('./plan');

const SEED = 20260925;
const RATE_PER_MIN = 6;
const MINUTES = 12;

function main() {
  const { bundle } = loadBundle(path.join(__dirname, '..', '..', 'policies', 'dias-governance-policy-v1.json'));
  const random = rng(SEED);
  const users = buildUsers().filter((user) => user.org !== 'court');
  const pools = new Map();
  for (const profile of world.REQUESTERS) {
    const combos = combinationsFor(profile, bundle);
    for (const expected of ['ALLOW', 'DENY']) {
      pools.set(`${profile.username}|${expected}`, shuffle(combos.filter((c) => c.expected === expected), random));
    }
  }
  const used = new Set();
  const arrivals = [];
  let atMs = 0;
  for (;;) {
    atMs += (-Math.log(1 - random()) / RATE_PER_MIN) * 60000;
    if (atMs >= MINUTES * 60000) break;
    const user = users[Math.floor(random() * users.length)];
    const list = pools.get(`${user.profile}|${user.slotExpectation}`).filter((c) => !used.has(c.verifiedRequestHash));
    const combo = list[0];
    used.add(combo.verifiedRequestHash);
    pools.set(`${user.profile}|${user.slotExpectation}`, list.slice(1));
    const id = `E7-${String(arrivals.length + 1).padStart(4, '0')}`;
    arrivals.push({
      id, offsetMs: Math.round(atMs), slot: user.slot, username: user.username, profile: user.profile, ...combo,
      justification: `Fault-window check ${id}: ${combo.action} ${combo.recordId} for ${combo.purpose}.`,
    });
  }
  const out = path.join(__dirname, 'generated', 'fault-plan.json');
  const body = { meta: { seed: SEED, steadyRatePerMinute: RATE_PER_MIN, minutes: MINUTES, excludedOrganization: 'court' }, arrivals };
  fs.writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  console.log(`fault plan: ${arrivals.length} arrivals over ${MINUTES} min; sha256 ${digest}`);
}

main();
