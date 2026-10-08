#!/usr/bin/env node
'use strict';

/**
 * Smoke test of the full testbed path before any measured run.
 *
 * Sends four workflows (two the policy allows, two it denies) whose facts are
 * in neither experiment plan, then checks, for each one:
 *  - the request committed and a V7 recommendation was produced;
 *  - the auditor decision committed with the recommendation value on-chain and
 *    the agreement derived by the chaincode;
 *  - the ledger trail holds the request and the decision but not the
 *    justification or the model's reason text (they stay off-chain).
 */

const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../policies/lib/bundle');
const { buildUsers, combinationsFor } = require('./plan');
const world = require('../seed/world');
const { createClient, createWatcher, runWorkflow } = require('./workflow');
const { ledgerOnly } = require('../../scripts/dias/acceptance-client');
const { ledgerLeaks } = require('../../scripts/dias/ledger-privacy');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.out || !/^[a-f0-9]{64}$/.test(opts['expected-adapter-hash'] || '')) {
    throw new Error('--out and --expected-adapter-hash (SHA-256 of the served adapter file) are required');
  }
  if (fs.existsSync(opts.out)) throw new Error('smoke output exists; retain the earlier evidence');
  const url = opts.url || 'http://dias-backend:3001/api';
  const generated = path.join(__dirname, 'generated');
  const planned = new Set();
  const burst = JSON.parse(fs.readFileSync(path.join(generated, 'burst-plan.json'), 'utf8'));
  const steady = JSON.parse(fs.readFileSync(path.join(generated, 'steady-plan.json'), 'utf8'));
  for (const request of [...burst.warmup, ...burst.batches.flatMap((b) => b.requests), ...steady.arrivals]) {
    planned.add(request.verifiedRequestHash);
  }
  const { bundle } = loadBundle(path.join(__dirname, '..', '..', 'policies', 'dias-governance-policy-v1.json'));
  const users = buildUsers();
  const picks = [];
  for (const [username, expected] of [['lt001.judge', 'ALLOW'], ['lt002.sho', 'DENY'], ['lt003.io', 'ALLOW'], ['lt004.const', 'DENY']]) {
    const user = users.find((u) => u.username === username);
    const profile = world.REQUESTERS.find((p) => p.username === user.profile);
    const combo = combinationsFor(profile, bundle)
      .find((c) => c.expected === expected && !planned.has(c.verifiedRequestHash));
    if (!combo) throw new Error(`no unplanned smoke fixture for ${username}/${expected}`);
    picks.push({ user, request: { ...combo, id: `SMOKE-${picks.length + 1}`, slot: user.slot, username, profile: user.profile, justification: `Smoke test ${picks.length + 1}: ${combo.action} ${combo.recordId} for ${combo.purpose}.` } });
  }

  const client = createClient(url);
  const watcher = createWatcher(client);
  const checks = [];
  const rows = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };
  for (const { user, request } of picks) {
    const row = await runWorkflow({ client, watcher, request, user, timeoutMs: 900000, extra: { phase: 'smoke' } });
    rows.push(row);
    console.log(JSON.stringify({ id: row.id, status: row.status, requestId: row.requestId, expected: row.expected, recommendation: row.recommendation, reasonCode: row.reasonCode, ledgerRecommendation: row.ledgerRecommendation, ledgerAgreement: row.ledgerAgreement, endToEndMs: row.endToEndMs, error: row.error }));
    check(`${request.id} completed`, row.status === 'completed', row.error || 'ok');
    if (row.status !== 'completed') continue;
    check(`${request.id} ledger facts = planned facts`, row.plannedFactsMatch, row.verifiedRequestHash);
    check(`${request.id} served adapter matches the supplied digest`, row.adapterHash === opts['expected-adapter-hash'], row.adapterHash);
    check(`${request.id} recommendation committed and verified`, row.recommendationState === 'committed'
      && row.integrityStatus === 'verified', `${row.recommendationState}/${row.integrityStatus}`);
    check(`${request.id} recommendation value committed on-chain`, row.ledgerRecommendation === row.recommendation, row.ledgerRecommendation);
    check(`${request.id} agreement derived on-chain`, row.ledgerAgreement === 'AGREED', row.ledgerAgreement);
    const trail = await client.trail(row.requestId, row.auditor);
    const ledgerPart = ledgerOnly(trail.data || {});
    check(`${request.id} request readable from the ledger`, trail.status === 200, trail.status);
    check(`${request.id} explanation payload absent from ledger`, ledgerLeaks(ledgerPart).length === 0
      && !JSON.stringify(ledgerPart).includes(request.justification), ledgerLeaks(ledgerPart));
  }
  const failed = checks.filter((c) => !c.ok);
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify({ artifactType: 'dias-testbed-smoke',
    capturedAtUtc: new Date().toISOString(), apiUrl: url, expectedAdapterHash: opts['expected-adapter-hash'],
    modelProvenance: rows[0] && rows[0].modelProvenance,
    summary: { passed: checks.length - failed.length, total: checks.length, failed: failed.length }, rows, checks }, null, 2)}\n`);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
