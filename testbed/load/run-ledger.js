#!/usr/bin/env node
'use strict';

/**
 * E3: capacity of the blockchain part alone, one contract function at a time.
 *
 * A closed-loop fixed-load driver (the same idea as Hyperledger Caliper's
 * fixed-load rate controller): at each level, exactly C transactions are kept
 * in flight — C simultaneous clients, each sending its next transaction as soon
 * as the previous one returns. Levels C = 10, 25, 50, 75, 100.
 *
 * For every level the rounds are:
 *   W1 CreateAccessRequest    (write; the 100 load users as requesters), 60 s
 *   W2 SubmitAuditorDecision  (write; the five district heads decide every
 *                              request W1 created, so nothing is left pending)
 *   R1 GetRequest             (read; evaluate only, no ordering), 30 s
 *   R2 QueryAccessDecisions   (read; the public decision log, newest 50), 30 s
 *
 * Each write is timed in three stages with the Fabric Gateway client:
 * endorsement, hand-off to the ordering service, and the wait until the block
 * holding it is committed. No LLM is involved.
 *
 * Usage: node testbed/load/run-ledger.js --out /results/<run> [--levels 10,25]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const APP = path.resolve(__dirname, '..', '..');
const grpc = require(path.join(APP, 'backend/node_modules/@grpc/grpc-js'));
const { connect, signers } = require(path.join(APP, 'backend/node_modules/@hyperledger/fabric-gateway'));
const { ORG_CONFIG, CHANNEL, CHAINCODE } = require(path.join(APP, 'backend/src/config'));
const world = require('../seed/world');

const ORGS_DIR = path.join(APP, 'network', 'organizations', 'peerOrganizations');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value) => Math.round(value * 1000) / 1000;
const utf8 = new TextDecoder();

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

const clients = new Map();
function grpcClient(org) {
  if (!clients.has(org)) {
    const cfg = ORG_CONFIG[org];
    const tls = fs.readFileSync(path.join(ORGS_DIR, cfg.domain, 'tlsca', `tlsca.${cfg.domain}-cert.pem`));
    clients.set(org, new grpc.Client(cfg.peerEndpoint, grpc.credentials.createSsl(tls), {
      'grpc.ssl_target_name_override': cfg.peerHostAlias,
    }));
  }
  return clients.get(org);
}

function contractFor(org, username, contractName) {
  const cfg = ORG_CONFIG[org];
  const msp = path.join(ORGS_DIR, cfg.domain, 'users', `${username}@${cfg.domain}`, 'msp');
  const first = (dir) => path.join(dir, fs.readdirSync(dir)[0]);
  const gateway = connect({
    client: grpcClient(org),
    identity: { mspId: cfg.mspId, credentials: fs.readFileSync(first(path.join(msp, 'signcerts'))) },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(first(path.join(msp, 'keystore'))))),
    evaluateOptions: () => ({ deadline: Date.now() + 30000 }),
    endorseOptions: () => ({ deadline: Date.now() + 60000 }),
    submitOptions: () => ({ deadline: Date.now() + 60000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 120000 }),
  });
  return gateway.getNetwork(CHANNEL).getContract(CHAINCODE, contractName);
}

async function timedSubmit(contract, fn, argsList) {
  const t0 = now();
  try {
    const transaction = await contract.newProposal(fn, { arguments: argsList }).endorse();
    const t1 = now();
    const submitted = await transaction.submit();
    const t2 = now();
    const status = await submitted.getStatus();
    const t3 = now();
    const row = {
      fn, ok: status.successful, code: status.code, txId: status.transactionId,
      blockNumber: String(status.blockNumber), startedAt: round(t0), finishedAt: round(t3),
      endorseMs: round(t1 - t0), ordererSubmitMs: round(t2 - t1), commitWaitMs: round(t3 - t2), totalMs: round(t3 - t0),
    };
    if (status.successful) row.result = JSON.parse(utf8.decode(submitted.getResult()));
    return row;
  } catch (error) {
    return { fn, ok: false, error: String(error.message || error).slice(0, 300), startedAt: round(t0), finishedAt: round(now()), totalMs: round(now() - t0) };
  }
}

async function timedEvaluate(contract, fn, argsList) {
  const t0 = now();
  try {
    const result = await contract.evaluateTransaction(fn, ...argsList);
    const t1 = now();
    return { fn, ok: true, startedAt: round(t0), finishedAt: round(t1), totalMs: round(t1 - t0), bytes: result.length };
  } catch (error) {
    return { fn, ok: false, error: String(error.message || error).slice(0, 300), startedAt: round(t0), finishedAt: round(now()), totalMs: round(now() - t0) };
  }
}

/** Keep `level` operations in flight until `durationMs` passes or `nextJob` runs out. */
async function fixedLoad(level, durationMs, nextJob, perform) {
  const rows = [];
  const deadline = now() + durationMs;
  const start = now();
  async function worker(index) {
    for (;;) {
      if (durationMs && now() >= deadline) return;
      const job = nextJob(index);
      if (job === null) return;
      rows.push(await perform(job, index));
    }
  }
  await Promise.all(Array.from({ length: level }, (_, index) => worker(index)));
  return { rows, startedAt: round(start), finishedAt: round(now()) };
}

function summarize(label, level, round0) {
  const ok = round0.rows.filter((row) => row.ok);
  const sorted = (key) => ok.map((row) => row[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const pct = (values, p) => (values.length === 0 ? null
    : round(values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))]));
  const mean = (values) => (values.length === 0 ? null : round(values.reduce((a, b) => a + b, 0) / values.length));
  const durationS = (round0.finishedAt - round0.startedAt) / 1000;
  const total = sorted('totalMs');
  return {
    round: label, level, attempted: round0.rows.length, succeeded: ok.length,
    failed: round0.rows.length - ok.length, durationS: round(durationS),
    throughputPerS: round(ok.length / durationS),
    latencyMs: { mean: mean(total), p50: pct(total, 0.5), p95: pct(total, 0.95), max: total.length ? total[total.length - 1] : null },
    stagesMeanMs: {
      endorse: mean(sorted('endorseMs')), ordererSubmit: mean(sorted('ordererSubmitMs')), commitWait: mean(sorted('commitWaitMs')),
    },
    startedAt: round0.startedAt, finishedAt: round0.finishedAt,
    errors: [...new Set(round0.rows.filter((row) => !row.ok).map((row) => row.error || `code ${row.code}`))].slice(0, 5),
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const outDir = opts.out;
  if (!outDir) throw new Error('--out is required');
  const levels = (opts.levels || '10,25,50,75,100').split(',').map(Number);
  const writeSeconds = Number(opts['write-seconds'] || 60);
  const readSeconds = Number(opts['read-seconds'] || 30);
  const pauseMs = Number(opts.pause || 20000);
  fs.mkdirSync(outDir, { recursive: true });
  const rowsFile = path.join(outDir, 'transactions.jsonl');
  const users = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated', 'users.json'), 'utf8'));
  const auditors = ['sp.north', 'sp.south', 'cfo.north', 'dp.north', 'dj.north'];
  // Users with a revoked certificate credential are left out: their requests are
  // policy denials, not ledger load.
  const requesterContracts = users.filter((user) => user.certCredentialStatus === 'active')
    .map((user) => ({ user, contract: contractFor(user.org, user.username, 'AccessContract') }));
  const auditorContracts = auditors.map((username) => contractFor('audit', username, 'AccessContract'));
  const combos = [];
  for (const record of world.RECORDS) {
    for (const action of ['view', 'export', 'annotate']) {
      for (const purpose of ['investigation', 'prosecution', 'judicial-proceeding', 'audit-review']) {
        combos.push({ recordId: record.recordId, action, purpose });
      }
    }
  }
  const summaries = [];
  const log = (label, rows, level) => {
    for (const row of rows) fs.appendFileSync(rowsFile, `${JSON.stringify({ round: label, level, ...row, result: undefined })}\n`);
  };

  for (const level of levels) {
    // W1: create requests.
    let counter = 0;
    const created = [];
    const w1 = await fixedLoad(level, writeSeconds * 1000, (index) => {
      counter += 1;
      const { user, contract } = requesterContracts[index % requesterContracts.length];
      const combo = combos[(counter * 7 + index) % combos.length];
      return { user, contract, combo };
    }, async ({ user, contract, combo }) => {
      const row = await timedSubmit(contract, 'CreateAccessRequest', [
        combo.recordId, JSON.stringify({ action: combo.action, purpose: combo.purpose, emergencyFlag: false }),
      ]);
      if (row.ok && row.result && row.result.requestId) created.push({ requestId: row.result.requestId, user });
      return { ...row, username: user.username };
    });
    log('W1', w1.rows, level);
    summaries.push(summarize('W1 CreateAccessRequest', level, w1));
    await sleep(pauseMs);

    // W2: decide every request W1 created.
    const queue = [...created];
    const w2 = await fixedLoad(level, 0, () => (queue.length ? queue.shift() : null), async ({ requestId }, index) => {
      const row = await timedSubmit(auditorContracts[index % auditorContracts.length], 'SubmitAuditorDecision', [
        requestId, 'FORCE_DENY', 'DENY', '',
      ]);
      return { ...row, requestId };
    });
    log('W2', w2.rows, level);
    summaries.push(summarize('W2 SubmitAuditorDecision', level, w2));
    await sleep(pauseMs);

    // R1: read single requests.
    let readTurn = 0;
    const r1 = await fixedLoad(level, readSeconds * 1000, () => {
      readTurn += 1;
      return created[readTurn % Math.max(1, created.length)];
    }, async ({ requestId, user }) => {
      const contract = requesterContracts.find((item) => item.user.username === user.username).contract;
      return timedEvaluate(contract, 'GetRequest', [requestId]);
    });
    log('R1', r1.rows, level);
    summaries.push(summarize('R1 GetRequest', level, r1));
    await sleep(pauseMs);

    // R2: the public decision log (newest 50).
    const r2 = await fixedLoad(level, readSeconds * 1000, () => ({}), (job, index) => (
      timedEvaluate(auditorContracts[index % auditorContracts.length], 'QueryAccessDecisions', ['50'])));
    log('R2', r2.rows, level);
    summaries.push(summarize('R2 QueryAccessDecisions', level, r2));
    fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summaries, null, 2)}\n`);
    process.stdout.write(`level ${level} done: ${summaries.slice(-4).map((s) => `${s.round.split(' ')[0]} ${s.throughputPerS}/s p50 ${s.latencyMs.p50} ms`).join('; ')}\n`);
    await sleep(pauseMs);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(`ledger run failed: ${error.stack || error}`);
  process.exit(1);
});
