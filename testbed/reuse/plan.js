#!/usr/bin/env node
'use strict';

/**
 * Pre-registered plan for the reuse experiment at 100 users: the live version of
 * the scope replay behind the paper's "Reusable Authorization Scope" figure.
 *
 * The old replay (experiments/dias/run-scope-workload-sweep.js) used 60 synthetic
 * users, one case each, two sibling records per case, and 0, 1, 3 and 7 repeated
 * requests per record. This plan keeps that design and runs it on the testbed:
 *  - users: the 100 testbed load users. User i sends one base request whose
 *    policy answer is fixed by the slot (odd ALLOW, even DENY), with verified
 *    facts that differ between users, as in the E5 plan;
 *  - records: each base request gets its own copy of the chosen world record in
 *    the world case, plus two siblings with the same record properties in a
 *    different case (a copy of the world case with the same assigned users). That
 *    is 300 records, each requested by exactly one user with one action and purpose;
 *  - rounds 0..7: in round 0 every user sends its three requests once, and every
 *    later round repeats all of them, so after round r each record has had r
 *    repeated requests (the paper's conditions are r = 0, 1, 3 and 7);
 *  - auditor: one approval decision per base request, drawn once in sorted order
 *    before anything runs (the fixed-approval correction of reviewer comment 32).
 *    The auditor overrides a model DENY to FORCE_ALLOW only for an approved base
 *    request, whose siblings share its decision, and otherwise follows the model;
 *  - justification: one fixed text per record, so a repeated request is the same
 *    request again and the model receives the same prompt.
 *
 * Usage: node testbed/reuse/plan.js [--smoke] [--prefix <record prefix> --seed <n>] [--out <file>]
 * (--prefix gives a repeated smoke test its own records, since a record keeps its authorizations.)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const world = require('../seed/world');
const { combinationsFor, rng, shuffle } = require('../load/plan');
const { loadBundle } = require(path.join(REPO, 'policies/lib/bundle'));
const { evaluateReference } = require(path.join(REPO, 'policies/reference-oracle/referencePolicyOracle'));
const { buildVerifiedRequest, verifiedRequestHash } = require(
  path.join(REPO, 'chaincode/crimerecords/lib/dias/verifiedRequest')
);

const FULL = Object.freeze({
  label: 'reuse-100-users', prefix: 'RU', seed: 20260925, users: 100, rounds: 8, approvalProbability: 0.5,
});
/** Four users, three rounds, and every denied base approved, so one smoke run exercises every path. */
const SMOKE = Object.freeze({
  label: 'reuse-smoke', prefix: 'RUSMK', seed: 20260926, users: 4, rounds: 3, approvalProbability: 1,
});
const SIBLINGS = 2;
const USERS_FILE = path.join(REPO, 'testbed/load/generated/users.json');

const JUSTIFICATIONS = [
  (r, n) => `Reviewing ${r.recordId} to ${r.action} it for ${r.purpose}; work item ${n}.`,
  (r, n) => `Need to ${r.action} ${r.recordId} as part of ${r.purpose} duties (ticket ${n}).`,
  (r, n) => `Request ${n}: ${r.purpose} requires me to ${r.action} record ${r.recordId}.`,
  (r, n) => `Routine ${r.purpose} step ${n}: ${r.action} access to ${r.recordId} is requested.`,
];

const siblingCaseId = (caseId, k) => `${caseId}-SIB${k}`;
const baseCaseOf = (caseId) => caseId.replace(/-SIB\d+$/, '');

/** A sibling case has the assigned users of the world case it copies. */
function assignedTo(profileName, caseId) {
  return world.assignedCases(profileName).includes(baseCaseOf(caseId));
}

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
    assignedToRequestedCase: assignedTo(profile.username, record.caseId),
  });
}

/**
 * Draw one base request per user without repeating verified facts across users.
 * Denials cycle over each profile's reason codes, as in the E5 plan.
 */
function drawBases(users, bundle, random) {
  const pools = new Map();
  for (const profile of world.REQUESTERS) {
    const combos = combinationsFor(profile, bundle);
    for (const expected of ['ALLOW', 'DENY']) {
      pools.set(`${profile.username}|${expected}`, shuffle(combos.filter((c) => c.expected === expected), random));
    }
  }
  const used = new Set();
  const reasonTurn = new Map();
  return users.map((user) => {
    const key = `${user.profile}|${user.slotExpectation}`;
    const list = pools.get(key).filter((item) => !used.has(item.verifiedRequestHash));
    if (list.length === 0) throw new Error(`pool exhausted: ${key}`);
    let index = 0;
    if (user.slotExpectation === 'DENY') {
      const codes = [...new Set(list.map((item) => item.expectedReasonCode))].sort();
      const turn = reasonTurn.get(key) || 0;
      reasonTurn.set(key, turn + 1);
      index = list.findIndex((item) => item.expectedReasonCode === codes[turn % codes.length]);
    }
    const picked = list[index];
    pools.set(key, list.filter((_, i) => i !== index));
    used.add(picked.verifiedRequestHash);
    return picked;
  });
}

function caseBody(item, loadUsers) {
  return {
    owningAgency: item.owningAgency,
    jurisdiction: item.jurisdiction,
    status: item.status,
    assignedUsers: [
      ...item.assignedProfiles,
      ...loadUsers.filter((user) => item.assignedProfiles.includes(user.profile)).map((user) => user.username),
    ],
    protectedClassifications: item.protectedClassifications,
  };
}

function buildPlan(settings, loadUsers, bundle) {
  const random = rng(settings.seed);
  const profiles = new Map(world.REQUESTERS.map((profile) => [profile.username, profile]));
  const worldRecords = new Map(world.RECORDS.map((record) => [record.recordId, record]));
  const users = loadUsers.slice(0, settings.users);
  const draws = drawBases(users, bundle, random);

  const streams = [];
  const bases = [];
  users.forEach((user, i) => {
    const draw = draws[i];
    const baseId = `${settings.prefix}${String(user.slot).padStart(3, '0')}`;
    const source = worldRecords.get(draw.recordId);
    const copies = [{ kind: 'base', streamId: `${baseId}-BASE`, caseId: source.caseId }];
    for (let k = 1; k <= SIBLINGS; k += 1) {
      copies.push({ kind: 'sibling', streamId: `${baseId}-SIB${k}`, caseId: siblingCaseId(source.caseId, k) });
    }
    for (const copy of copies) {
      const record = { ...source, recordId: copy.streamId, caseId: copy.caseId };
      const verifiedRequest = verifiedFor(profiles.get(user.profile), record, draw.action, draw.purpose);
      const reference = evaluateReference(bundle, verifiedRequest);
      if (reference.recommendation !== draw.expected || reference.reason_code !== draw.expectedReasonCode) {
        throw new Error(`${copy.streamId}: the policy answer differs from its base request`);
      }
      const facts = { recordId: copy.streamId, action: draw.action, purpose: draw.purpose };
      streams.push({
        streamId: copy.streamId,
        base: baseId,
        kind: copy.kind,
        slot: user.slot,
        username: user.username,
        profile: user.profile,
        recordId: copy.streamId,
        caseId: copy.caseId,
        worldRecordId: source.recordId,
        record,
        action: draw.action,
        purpose: draw.purpose,
        expected: reference.recommendation,
        expectedReasonCode: reference.reason_code,
        verifiedRequest,
        verifiedRequestHash: verifiedRequestHash(verifiedRequest),
        justification: JUSTIFICATIONS[Math.floor(random() * JUSTIFICATIONS.length)](facts, copy.streamId),
      });
    }
    bases.push({ base: baseId, slot: user.slot, username: user.username, expected: draw.expected });
  });

  // One approval decision per base request, drawn in sorted order and never redrawn.
  const auditorRandom = rng(settings.seed + 1);
  const approve = new Map([...bases].map((b) => b.base).sort().map((id) => [id, auditorRandom() < settings.approvalProbability]));
  const baseList = bases.map((b) => ({ ...b, approveIfModelDenies: approve.get(b.base) }));

  const rounds = [];
  for (let round = 0; round < settings.rounds; round += 1) {
    const order = {};
    for (const user of users) {
      order[user.username] = shuffle(streams.filter((s) => s.username === user.username).map((s) => s.streamId), random);
    }
    rounds.push({ round, repeatsAfterRound: round, order });
  }

  const usedCases = new Set(streams.map((s) => baseCaseOf(s.caseId)));
  const siblingCases = world.CASES.filter((item) => usedCases.has(item.caseId)).flatMap((item) => {
    const body = caseBody(item, loadUsers);
    return Array.from({ length: SIBLINGS }, (_, k) => ({ caseId: siblingCaseId(item.caseId, k + 1), copyOf: item.caseId, body }));
  });

  return {
    meta: {
      label: settings.label,
      seed: settings.seed,
      users: users.length,
      siblingsPerBase: SIBLINGS,
      rounds: settings.rounds,
      approvalProbability: settings.approvalProbability,
      auditorRule: 'FORCE_ALLOW over a model DENY only when the base request is approved; otherwise follow the model; deny an unusable recommendation',
      generatedBy: 'testbed/reuse/plan.js',
    },
    bases: baseList,
    streams,
    siblingCases,
    rounds,
  };
}

function main() {
  const smoke = process.argv.includes('--smoke');
  const option = (name) => (process.argv.indexOf(name) > 0 ? process.argv[process.argv.indexOf(name) + 1] : null);
  const prefix = option('--prefix');
  const settings = prefix
    ? { ...(smoke ? SMOKE : FULL), prefix, seed: Number(option('--seed')), label: `${(smoke ? SMOKE : FULL).label}-${prefix.toLowerCase()}` }
    : (smoke ? SMOKE : FULL);
  if (prefix && !Number.isInteger(settings.seed)) throw new Error('--prefix needs --seed <integer>');
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex > 0
    ? path.resolve(process.argv[outIndex + 1])
    : path.join(__dirname, 'generated', `${settings.label}-plan.json`);
  const { bundle, bundleHash } = loadBundle(path.join(REPO, 'policies', 'dias-governance-policy-v1.json'));
  const usersText = fs.readFileSync(USERS_FILE);
  const plan = buildPlan(settings, JSON.parse(usersText), bundle);
  plan.meta.policyBundleHash = bundleHash;
  plan.meta.usersSha256 = crypto.createHash('sha256').update(usersText).digest('hex');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`);

  const approved = plan.bases.filter((b) => b.approveIfModelDenies);
  const approvedDeny = approved.filter((b) => b.expected === 'DENY');
  console.log(`${settings.label}: ${plan.bases.length} users, ${plan.streams.length} records, ${plan.rounds.length} rounds`);
  console.log(`base answers: ALLOW ${plan.bases.filter((b) => b.expected === 'ALLOW').length}, DENY ${plan.bases.filter((b) => b.expected === 'DENY').length}`);
  console.log(`approved base requests: ${approved.length} (of them policy-DENY: ${approvedDeny.length}, i.e. ${approvedDeny.length * (SIBLINGS + 1)} records)`);
  console.log(`sibling cases: ${plan.siblingCases.map((c) => c.caseId).join(', ')}`);
  console.log(`plan sha256: ${crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex')} -> ${path.relative(REPO, out)}`);
}

if (require.main === module) main();

module.exports = { FULL, SMOKE, SIBLINGS, assignedTo, baseCaseOf, buildPlan, siblingCaseId, verifiedFor };
