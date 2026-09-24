'use strict';

/**
 * Fabric Gateway connections — one per logged-in user, so every transaction
 * is signed with that individual's X.509 identity and the ledger attributes
 * actions to the person, not to this server.
 */

const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');
const { NETWORK_DIR, ORG_CONFIG, CHANNEL, CHAINCODE } = require('../config');
const { withCommitRetry } = require('./commitErrors');

const grpcClients = new Map();   // org -> grpc.Client (shared per org)
const gateways = new Map();      // username -> Gateway

function orgPaths(org, fabricUser) {
  const cfg = ORG_CONFIG[org];
  const orgDir = path.join(NETWORK_DIR, 'organizations', 'peerOrganizations', cfg.domain);
  const userMsp = path.join(orgDir, 'users', `${fabricUser}@${cfg.domain}`, 'msp');
  return {
    cfg,
    tlsCert: path.join(orgDir, 'tlsca', `tlsca.${cfg.domain}-cert.pem`),
    certDir: path.join(userMsp, 'signcerts'),
    keyDir: path.join(userMsp, 'keystore'),
  };
}

function firstFile(dir) {
  const files = fs.readdirSync(dir);
  if (files.length === 0) throw new Error(`no files in ${dir}`);
  return path.join(dir, files[0]);
}

function getGrpcClient(org) {
  if (!grpcClients.has(org)) {
    const { cfg, tlsCert } = orgPaths(org, 'unused');
    const credentials = grpc.credentials.createSsl(fs.readFileSync(tlsCert));
    grpcClients.set(org, new grpc.Client(cfg.peerEndpoint, credentials, {
      'grpc.ssl_target_name_override': cfg.peerHostAlias,
    }));
  }
  return grpcClients.get(org);
}

/** Connect (or reuse) a gateway for a specific enrolled user. */
function getGateway(org, fabricUser) {
  const cacheKey = `${org}/${fabricUser}`;
  if (gateways.has(cacheKey)) return gateways.get(cacheKey);

  const { cfg, certDir, keyDir } = orgPaths(org, fabricUser);
  const credentials = fs.readFileSync(firstFile(certDir));
  const privateKeyPem = fs.readFileSync(firstFile(keyDir));
  const privateKey = crypto.createPrivateKey(privateKeyPem);

  const gateway = connect({
    client: getGrpcClient(org),
    identity: { mspId: cfg.mspId, credentials },
    signer: signers.newPrivateKeySigner(privateKey),
    evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions: () => ({ deadline: Date.now() + 10000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });
  gateways.set(cacheKey, gateway);
  return gateway;
}

/** Get a named contract (RecordContract/AccessContract/AuditContract) as a user. */
function getContract(org, fabricUser, contractName) {
  const network = getGateway(org, fabricUser).getNetwork(CHANNEL);
  return network.getContract(CHAINCODE, contractName);
}

const utf8 = new TextDecoder();

async function evaluate(org, user, contractName, fn, ...args) {
  const contract = getContract(org, user, contractName);
  const result = await contract.evaluateTransaction(fn, ...args);
  return JSON.parse(utf8.decode(result));
}

/** Submit and wait for commit; a commit conflict is proposed again (see commitErrors.js). */
async function submit(org, user, contractName, fn, ...args) {
  const contract = getContract(org, user, contractName);
  const result = await withCommitRetry(() => contract.submitTransaction(fn, ...args));
  return JSON.parse(utf8.decode(result));
}

/**
 * Submit with transient (private) data. Endorsement must be restricted to orgs in
 * the collection's distribution policy — Fabric rejects the proposal rather than
 * leak transient data to a non-member org — and the chosen set must still satisfy
 * the chaincode's MAJORITY endorsement policy, which is three of the five orgs on
 * the DIAS channel.
 */
const EVIDENCE_ENDORSERS = Object.freeze([
  'PoliceMSP', 'ForensicsMSP', 'ProsecutionMSP', 'CourtMSP',
]);

async function submitWithTransient(
  org, user, contractName, fn, args, transientData, endorsers = EVIDENCE_ENDORSERS
) {
  const contract = getContract(org, user, contractName);
  const result = await withCommitRetry(() => contract.submit(fn, {
    arguments: args,
    transientData,
    endorsingOrganizations: [...endorsers],
  }));
  return JSON.parse(utf8.decode(result));
}

module.exports = {
  evaluate,
  submit,
  submitWithTransient,
  EVIDENCE_ENDORSERS,
};
