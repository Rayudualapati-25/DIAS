#!/usr/bin/env node
'use strict';

/**
 * Evaluate-only ledger check for a reuse plan: submits no transaction. Lists
 * every dynamic authorization (any status) whose scope names a record of the
 * plan, and every one on the ledger in total, so the run can show that it
 * started from none and that each one it created covers exactly one user and
 * one record.
 *
 * Usage: node testbed/reuse/check-ledger.js --plan <plan.json> --label before|after --out <file.json>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP = path.resolve(__dirname, '..', '..');
const grpc = require(path.join(APP, 'backend/node_modules/@grpc/grpc-js'));
const { connect, signers } = require(path.join(APP, 'backend/node_modules/@hyperledger/fabric-gateway'));
const { ORG_CONFIG, CHANNEL, CHAINCODE } = require(path.join(APP, 'backend/src/config'));

const ORGS_DIR = path.join(APP, 'network', 'organizations', 'peerOrganizations');

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

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.plan || !opts.out) throw new Error('--plan and --out are required');
  const plan = JSON.parse(fs.readFileSync(path.resolve(APP, opts.plan), 'utf8'));
  const planRecords = new Set(plan.streams.map((stream) => stream.recordId));
  const auditor = contract('audit', 'sp.north');
  const raw = await auditor.evaluateTransaction('QueryDynamicAuthorizations', 'all');
  const all = JSON.parse(Buffer.from(raw).toString('utf8'));
  const inPlan = all.filter((item) => item.scope && planRecords.has(item.scope.recordId)).map((item) => ({
    authorizationId: item.authorizationId,
    status: item.status,
    generation: item.generation,
    scope: item.scope,
    originatingRequestId: item.originatingRequestId,
    llmRecommendation: item.auditorDecision ? item.auditorDecision.llmRecommendation : null,
    llmAgreement: item.auditorDecision ? item.auditorDecision.llmAgreement : null,
    createdAtUtc: item.createdAtUtc,
    validUntilUtc: item.validUntilUtc,
  }));
  const byStatus = (items) => items.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }), {});
  const report = {
    label: opts.label || 'check',
    atUtc: new Date().toISOString(),
    plan: plan.meta.label,
    ledgerAuthorizationsAll: all.length,
    ledgerAuthorizationsByStatus: byStatus(all),
    planAuthorizations: inPlan.length,
    planAuthorizationsByStatus: byStatus(inPlan),
    planAuthorizationList: inPlan,
  };
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, planAuthorizationList: undefined }));
  process.exit(0);
}

main().catch((error) => {
  console.error(`ledger check failed: ${error.stack || error}`);
  process.exit(1);
});
