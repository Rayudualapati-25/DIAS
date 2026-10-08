#!/usr/bin/env node
'use strict';

/**
 * Ledger-growth probe: how long the list reads take as the ledger grows.
 *
 * QueryPendingAuditorRequests and QueryAccessDecisions both scan every request
 * or decision ever written before they filter or sort, so their time grows with
 * the ledger; GetRequest reads one key and should stay flat. One client, one
 * read at a time (no other load), ten samples each.
 *
 * Usage: node testbed/load/probe-reads.js --label after-e5 --out /results/probes
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const APP = path.resolve(__dirname, '..', '..');
const grpc = require(path.join(APP, 'backend/node_modules/@grpc/grpc-js'));
const { connect, signers } = require(path.join(APP, 'backend/node_modules/@hyperledger/fabric-gateway'));
const { ORG_CONFIG, CHANNEL, CHAINCODE, NETWORK_DIR } = require(path.join(APP, 'backend/src/config'));

const ORGS_DIR = path.join(NETWORK_DIR, 'organizations', 'peerOrganizations');
const now = () => performance.timeOrigin + performance.now();

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

function contract(org, username) {
  const cfg = ORG_CONFIG[org];
  const tls = fs.readFileSync(path.join(ORGS_DIR, cfg.domain, 'tlsca', `tlsca.${cfg.domain}-cert.pem`));
  const client = new grpc.Client(cfg.peerEndpoint, grpc.credentials.createSsl(tls), {
    'grpc.ssl_target_name_override': cfg.peerHostAlias,
  });
  const msp = path.join(ORGS_DIR, cfg.domain, 'users', `${username}@${cfg.domain}`, 'msp');
  const first = (dir) => path.join(dir, fs.readdirSync(dir)[0]);
  const gateway = connect({
    client,
    identity: { mspId: cfg.mspId, credentials: fs.readFileSync(first(path.join(msp, 'signcerts'))) },
    signer: signers.newPrivateKeySigner(crypto.createPrivateKey(fs.readFileSync(first(path.join(msp, 'keystore'))))),
    evaluateOptions: () => ({ deadline: Date.now() + 120000 }),
  });
  return gateway.getNetwork(CHANNEL).getContract(CHAINCODE, 'AccessContract');
}

async function sample(target, fn, argsList, count) {
  const times = [];
  let bytes = 0;
  let items = null;
  for (let i = 0; i < count; i += 1) {
    const t0 = now();
    const result = await target.evaluateTransaction(fn, ...argsList);
    times.push(now() - t0);
    bytes = result.length;
    try {
      const parsed = JSON.parse(Buffer.from(result).toString('utf8'));
      items = Array.isArray(parsed) ? parsed.length : null;
    } catch (_error) { items = null; }
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    fn, samples: count, meanMs: times.reduce((a, b) => a + b, 0) / count,
    p50Ms: sorted[Math.floor(count / 2)], maxMs: sorted[count - 1], responseBytes: bytes, items,
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  const label = opts.label || 'probe';
  const outDir = opts.out || '/results/probes';
  const count = Number(opts.samples || 10);
  const auditor = contract('audit', 'sp.north');
  const results = [];
  results.push(await sample(auditor, 'QueryPendingAuditorRequests', [], count));
  results.push(await sample(auditor, 'QueryAccessDecisions', ['50'], count));
  const decisions = JSON.parse(Buffer.from(await auditor.evaluateTransaction('QueryAccessDecisions', '1')).toString('utf8'));
  const recent = decisions[0] ? decisions[0].requestId : null;
  if (recent) {
    try {
      results.push(await sample(auditor, 'GetRequest', [recent], count));
    } catch (error) {
      results.push({ fn: 'GetRequest', error: String(error.message || error).slice(0, 200) });
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const record = { label, at: now(), atUtc: new Date().toISOString(), results };
  fs.appendFileSync(path.join(outDir, 'probes.jsonl'), `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record));
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
