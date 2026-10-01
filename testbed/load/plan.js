#!/usr/bin/env node
'use strict';

/**
 * Pre-registered load plan for the multi-VM experiments.
 *
 * Produces, deterministically from one seed:
 *  - the 100 load-test users (clones of the 12 requester profiles of the demo
 *    world; identical policy facts, distinct names and certificates);
 *  - every request of the whole-system runs (E5: 10/25/50/75/100 users, three
 *    repetitions) and of the one-hour run (E6), each with the answer the written
 *    policy gives for it (the offline reference oracle; never part of the
 *    DIAS runtime).
 *
 * Design rules, so that load levels are comparable:
 *  - user i sends the i-th request of every batch; a batch of L users is users
 *    1..L, so every level reuses the same users and adds new ones;
 *  - odd users send requests the policy allows, even users requests it denies,
 *    so every batch is balanced (ceil(L/2) allow, floor(L/2) deny);
 *  - profiles are assigned to users in a fixed cycle, so the role mix is the
 *    same at every level;
 *  - within one run no two requests have the same verified facts, so the model
 *    server's prompt cache cannot make later requests cheaper than earlier ones.
 *
 * Usage: node testbed/load/plan.js [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const world = require('../seed/world');
const { loadBundle } = require(path.join(REPO, 'policies/lib/bundle'));
const { evaluateReference } = require(path.join(REPO, 'policies/reference-oracle/referencePolicyOracle'));
const { buildVerifiedRequest, verifiedRequestHash } = require(
  path.join(REPO, 'chaincode/crimerecords/lib/dias/verifiedRequest')
);

const SEED = 20260924;
const LEVELS = [10, 25, 50, 75, 100];
const REPETITIONS = 3;
const WARMUP = 5;
const STEADY_RATE_PER_MIN = 6;
const STEADY_MINUTES = 60;

/** ALLOW slots cycle over the profiles with enough allowed requests, weighted by supply. */
const ALLOW_CYCLE = [
  'judge.rana', 'io.krishnan', 'insp.sharma', 'pp.mehta',
  'judge.rana', 'io.krishnan', 'insp.sharma', 'pp.mehta',
  'insp.singh', 'dir.iyer',
];
/** DENY slots cycle over all twelve requester profiles. */
const DENY_CYCLE = [
  'sho.reddy', 'const.verma', 'insp.rathore', 'analyst.rao', 'dc.nair', 'clerk.das',
  'insp.sharma', 'io.krishnan', 'insp.singh', 'dir.iyer', 'pp.mehta', 'judge.rana',
];

/** mulberry32: small, deterministic PRNG. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const profileByName = new Map(world.REQUESTERS.map((profile) => [profile.username, profile]));

function verifiedFor(profile, record, action, purpose) {
  return buildVerifiedRequest({
    subject: {
      mspId: world.MSP[profile.org],
      organization: profile.org,
      role: profile.role,
      rank: profile.rank,
      station: profile.station,
      jurisdiction: profile.jurisdiction,
      clearance: profile.clearance,
      credentialStatus: profile.certCredentialStatus,
    },
    record: { ...record, sealed: false },
    requestContext: { action, purpose, emergencyFlag: false, approvalTokenPresent: false },
    assignedToRequestedCase: world.assignedCases(profile.username).includes(record.caseId),
  });
}

/** Every (record, action, purpose) a profile can send, with the policy's answer. */
function combinationsFor(profile, bundle) {
  const out = [];
  for (const record of world.RECORDS) {
    for (const action of bundle.vocabularies.actions) {
      for (const purpose of bundle.vocabularies.purposes) {
        const verified = verifiedFor(profile, record, action, purpose);
        const reference = evaluateReference(bundle, verified);
        out.push({
          recordId: record.recordId,
          action,
          purpose,
          expected: reference.recommendation,
          expectedReasonCode: reference.reason_code,
          expectedDecisiveClause: reference.decisive_clause,
          verifiedRequestHash: verifiedRequestHash(verified),
        });
      }
    }
  }
  return out;
}

function buildUsers() {
  const users = [];
  let allowIndex = 0;
  let denyIndex = 0;
  for (let slot = 1; slot <= 100; slot += 1) {
    const expected = slot % 2 === 1 ? 'ALLOW' : 'DENY';
    const profileName = expected === 'ALLOW'
      ? ALLOW_CYCLE[(allowIndex++) % ALLOW_CYCLE.length]
      : DENY_CYCLE[(denyIndex++) % DENY_CYCLE.length];
    const profile = profileByName.get(profileName);
    const username = `lt${String(slot).padStart(3, '0')}.${profileName.split('.')[0]}`;
    users.push({
      slot,
      username,
      profile: profileName,
      slotExpectation: expected,
      org: profile.org,
      role: profile.role,
      displayName: `Load user ${slot} (${profile.role})`,
      rank: profile.rank,
      station: profile.station,
      jurisdiction: profile.jurisdiction,
      clearance: profile.clearance,
      certCredentialStatus: profile.certCredentialStatus,
      badgeId: `LT-${String(slot).padStart(3, '0')}`,
      caseAssignments: world.assignedCases(profileName),
    });
  }
  return users;
}

const JUSTIFICATIONS = [
  (r, n) => `Reviewing ${r.recordId} to ${r.action} it for ${r.purpose}; work item ${n}.`,
  (r, n) => `Need to ${r.action} ${r.recordId} as part of ${r.purpose} duties (ticket ${n}).`,
  (r, n) => `Request ${n}: ${r.purpose} requires me to ${r.action} record ${r.recordId}.`,
  (r, n) => `Routine ${r.purpose} step ${n}: ${r.action} access to ${r.recordId} is requested.`,
];

function justification(request, serial, random) {
  const template = JUSTIFICATIONS[Math.floor(random() * JUSTIFICATIONS.length)];
  return template(request, `${serial}`);
}

/**
 * Draw without replacement from a profile's pool of one expectation. Denials
 * cycle over the profile's reason codes so every run covers them all.
 */
function makeDrawer(pools, random) {
  const shuffled = new Map();
  const reasonTurn = new Map();
  // Two profiles can share every policy fact (for example two inspectors of one
  // station asking about a case neither is assigned to), so uniqueness is kept
  // across the whole run, not per profile.
  const used = new Set();
  for (const [key, list] of pools) shuffled.set(key, shuffle(list, random));
  return function draw(profileName, expected) {
    const key = `${profileName}|${expected}`;
    const list = (shuffled.get(key) || []).filter((item) => !used.has(item.verifiedRequestHash));
    shuffled.set(key, list);
    if (list.length === 0) throw new Error(`pool exhausted: ${key}`);
    let index = 0;
    if (expected === 'DENY') {
      const codes = [...new Set(list.map((item) => item.expectedReasonCode))].sort();
      const turn = reasonTurn.get(key) || 0;
      reasonTurn.set(key, turn + 1);
      const code = codes[turn % codes.length];
      index = list.findIndex((item) => item.expectedReasonCode === code);
    }
    const [picked] = list.splice(index, 1);
    used.add(picked.verifiedRequestHash);
    return picked;
  };
}

function buildPools(bundle) {
  const pools = new Map();
  for (const profile of world.REQUESTERS) {
    const combos = combinationsFor(profile, bundle);
    for (const expected of ['ALLOW', 'DENY']) {
      pools.set(`${profile.username}|${expected}`, combos.filter((c) => c.expected === expected));
    }
  }
  return pools;
}

function buildBurstRun(users, pools, random) {
  const draw = makeDrawer(pools, random);
  let serial = 0;
  const make = (user, phase, level, repetition) => {
    const combo = draw(user.profile, user.slotExpectation);
    serial += 1;
    return {
      id: `E5-${String(serial).padStart(4, '0')}`,
      phase, level, repetition, slot: user.slot, username: user.username, profile: user.profile,
      ...combo,
      justification: justification(combo, `E5-${serial}`, random),
    };
  };
  const warmup = users.slice(0, WARMUP).map((user) => make(user, 'warmup', 0, 0));
  const batches = [];
  for (const level of LEVELS) {
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      batches.push({
        level,
        repetition,
        requests: users.slice(0, level).map((user) => make(user, 'measured', level, repetition)),
      });
    }
  }
  return { warmup, batches };
}

/** One hour of Poisson arrivals at STEADY_RATE_PER_MIN from uniformly chosen users. */
function buildSteadyRun(users, pools, random) {
  const draw = makeDrawer(pools, random);
  const arrivals = [];
  let atMs = 0;
  let serial = 0;
  const horizon = STEADY_MINUTES * 60 * 1000;
  for (;;) {
    atMs += (-Math.log(1 - random()) / STEADY_RATE_PER_MIN) * 60 * 1000;
    if (atMs >= horizon) break;
    const user = users[Math.floor(random() * users.length)];
    const combo = draw(user.profile, user.slotExpectation);
    serial += 1;
    arrivals.push({
      id: `E6-${String(serial).padStart(4, '0')}`,
      offsetMs: Math.round(atMs), slot: user.slot, username: user.username, profile: user.profile,
      ...combo,
      justification: justification(combo, `E6-${serial}`, random),
    });
  }
  return arrivals;
}

function assertDistinct(requests, label) {
  const seen = new Set();
  for (const request of requests) {
    if (seen.has(request.verifiedRequestHash)) {
      throw new Error(`${label}: verified facts repeat (${request.id})`);
    }
    seen.add(request.verifiedRequestHash);
  }
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(REPO, 'testbed', 'load', 'generated'));
  const { bundle, bundleHash } = loadBundle(path.join(REPO, 'policies', 'dias-governance-policy-v1.json'));
  const random = rng(SEED);
  const users = buildUsers();
  const burst = buildBurstRun(users, buildPools(bundle), random);
  const steady = buildSteadyRun(users, buildPools(bundle), random);

  const burstRequests = [...burst.warmup, ...burst.batches.flatMap((b) => b.requests)];
  assertDistinct(burstRequests, 'E5');
  assertDistinct(steady, 'E6');
  for (const batch of burst.batches) {
    const allow = batch.requests.filter((r) => r.expected === 'ALLOW').length;
    if (allow !== Math.ceil(batch.level / 2)) throw new Error(`unbalanced batch ${batch.level}/${batch.repetition}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    seed: SEED, levels: LEVELS, repetitions: REPETITIONS, warmup: WARMUP,
    steadyRatePerMinute: STEADY_RATE_PER_MIN, steadyMinutes: STEADY_MINUTES,
    policyBundleHash: bundleHash,
    allowCycle: ALLOW_CYCLE, denyCycle: DENY_CYCLE,
  };
  const write = (name, value) => fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('users.json', users);
  write('burst-plan.json', { meta, ...burst });
  write('steady-plan.json', { meta, arrivals: steady });
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(outDir, 'burst-plan.json')))
    .update(fs.readFileSync(path.join(outDir, 'steady-plan.json')))
    .digest('hex');
  write('plan-meta.json', { ...meta, planSha256: digest, generatedBy: 'testbed/load/plan.js' });

  const count = (list, value) => list.filter((r) => r.expected === value).length;
  console.log(`users: ${users.length}`);
  console.log(`E5 warm-up: ${burst.warmup.length}; batches: ${burst.batches.length}; measured requests: ${burstRequests.length - burst.warmup.length}`
    + ` (ALLOW ${count(burstRequests, 'ALLOW')}, DENY ${count(burstRequests, 'DENY')})`);
  console.log(`E6 arrivals: ${steady.length} (ALLOW ${count(steady, 'ALLOW')}, DENY ${count(steady, 'DENY')})`);
  const reasons = {};
  for (const r of [...burstRequests, ...steady]) reasons[r.expectedReasonCode] = (reasons[r.expectedReasonCode] || 0) + 1;
  console.log(`expected reason codes: ${JSON.stringify(reasons)}`);
  console.log(`plan sha256: ${digest}`);
}

if (require.main === module) main();

module.exports = { buildUsers, combinationsFor, rng, shuffle, verifiedFor, LEVELS, REPETITIONS };
