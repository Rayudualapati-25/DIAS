'use strict';

/**
 * Fabric CA enrolment — issuing an X.509 identity to a new department user.
 *
 * This drives the same `fabric-ca-client` binary that
 * network/scripts/seed-identities.sh uses, for one reason: the MSP directory it
 * produces has to be byte-identical to a seeded one, right down to the
 * config.yaml that carries the NodeOU definitions. Reimplementing that layout
 * against the SDK would be a second thing to keep in sync with the first.
 *
 * The identity's role, station, clearance and so on are baked into the
 * certificate as attributes (":ecert" = carried in the enrolment cert). That is
 * what makes them usable by the chaincode's access policy: the attributes are
 * signed by the department's CA and cannot be altered by this server or by the
 * browser.
 *
 * Every value that reaches the command line is validated against an allow-list
 * first, and the process is spawned with an argument array rather than a shell
 * string, so nothing here can be turned into shell injection.
 */

const { execFile } = require('child_process');
const { randomBytes } = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { NETWORK_DIR, FABRIC_BIN, ORG_CONFIG } = require('../config');

const execFileAsync = promisify(execFile);

const CLIENT_BIN = path.join(FABRIC_BIN, 'fabric-ca-client');
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
// Attribute values: the seeded identities use '|' inside caseAssignments, so it
// has to be permitted, but nothing that could confuse the attribute parser.
const SAFE_ATTR_VALUE = /^[A-Za-z0-9._|-]{1,128}$/;

const ATTRIBUTE_NAMES = Object.freeze([
  'role', 'rank', 'station', 'jurisdiction', 'badgeId', 'clearance',
  'credentialStatus', 'caseAssignments',
]);

/** Generate a URL-safe, 256-bit CA enrolment secret. */
function generateEnrollmentSecret() {
  return randomBytes(32).toString('base64url');
}

function orgPaths(org) {
  const cfg = ORG_CONFIG[org];
  if (!cfg) throw new Error(`unknown organisation '${org}'`);
  const orgDir = path.join(NETWORK_DIR, 'organizations', 'peerOrganizations', cfg.domain);
  return {
    cfg,
    orgDir,
    caCert: path.join(NETWORK_DIR, 'organizations', 'fabric-ca', org, 'ca-cert.pem'),
    orgMspConfig: path.join(orgDir, 'msp', 'config.yaml'),
  };
}

/** Where an enrolled user's MSP material lives. */
function userMspPath(org, fabricUser) {
  const { cfg, orgDir } = orgPaths(org);
  return path.join(orgDir, 'users', `${fabricUser}@${cfg.domain}`, 'msp');
}

function isEnrolled(org, fabricUser) {
  return fs.existsSync(userMspPath(org, fabricUser));
}

/**
 * Turn a validated attribute object into the --id.attrs string.
 * ':ecert' puts each attribute into the certificate itself.
 */
function buildAttrString(attributes) {
  const parts = [];
  for (const name of ATTRIBUTE_NAMES) {
    const value = attributes[name];
    if (value === undefined || value === null || value === '') continue;
    if (!SAFE_ATTR_VALUE.test(String(value))) {
      throw new Error(`attribute '${name}' has an invalid value`);
    }
    parts.push(`${name}=${value}:ecert`);
  }
  if (parts.length === 0) {
    throw new Error('at least one identity attribute is required');
  }
  return parts.join(',');
}

/**
 * Run fabric-ca-client with the org's CA admin as the registrar.
 * FABRIC_CA_CLIENT_HOME points at the org directory, whose msp/ holds the
 * admin credentials created by registerEnroll.sh.
 */
async function runCaClient(org, args) {
  const { orgDir } = orgPaths(org);
  return execFileAsync(CLIENT_BIN, args, {
    env: { ...process.env, FABRIC_CA_CLIENT_HOME: orgDir, PATH: `${FABRIC_BIN}:${process.env.PATH}` },
    timeout: 30000,
  });
}

/**
 * Register a new identity with the department's CA and enrol it, leaving MSP
 * material on disk where fabric/gateway.js expects to find it.
 *
 * Returns the enrolment secret so it is never silently discarded; the caller
 * decides whether to show it. Idempotent: an already-enrolled user is left
 * alone rather than re-enrolled, which would invalidate their existing key.
 */
async function registerAndEnroll({ org, fabricUser, attributes }) {
  if (!SAFE_ID.test(fabricUser)) {
    throw new Error(`fabricUser '${fabricUser}' has an invalid format`);
  }
  const { cfg, caCert, orgMspConfig } = orgPaths(org);

  if (!fs.existsSync(caCert)) {
    throw new Error(`the ${org} CA is not running, or the network has not been started`);
  }
  if (isEnrolled(org, fabricUser)) {
    throw new Error(`identity '${fabricUser}' is already enrolled in ${org}`);
  }

  const attrString = buildAttrString(attributes);
  const secret = generateEnrollmentSecret();
  const mspDir = userMspPath(org, fabricUser);

  await runCaClient(org, [
    'register',
    '--caname', cfg.caName,
    '--id.name', fabricUser,
    '--id.secret', secret,
    '--id.type', 'client',
    '--id.attrs', attrString,
    '--tls.certfiles', caCert,
  ]);

  await runCaClient(org, [
    'enroll',
    '-u', `https://${fabricUser}:${secret}@localhost:${cfg.caPort}`,
    '--caname', cfg.caName,
    '-M', mspDir,
    '--tls.certfiles', caCert,
  ]);

  // Without the NodeOU definitions the peer cannot classify this certificate
  // as a client identity, and every transaction it signs is rejected.
  fs.copyFileSync(orgMspConfig, path.join(mspDir, 'config.yaml'));

  return { fabricUser, mspDir, secret };
}

/**
 * Delete an enrolled identity's MSP material.
 *
 * Used to clean up when registration succeeds at the CA but then fails on the
 * ledger, which would otherwise leave a certificate belonging to no account.
 * This removes the key material; the CA's own registry entry stays, because
 * withdrawing that is a revocation and needs the department to do it
 * deliberately. An identity in that state cannot sign in — sign-in reads the
 * account from the ledger, and there isn't one.
 */
function removeEnrollment(org, fabricUser) {
  const mspDir = userMspPath(org, fabricUser);
  fs.rmSync(path.dirname(mspDir), { recursive: true, force: true });
}

module.exports = {
  registerAndEnroll, removeEnrollment, isEnrolled, userMspPath,
  generateEnrollmentSecret, ATTRIBUTE_NAMES, SAFE_ID,
};
