#!/usr/bin/env node
'use strict';

/**
 * Register and activate the DIAS governance policy on the ledger (design §5).
 *
 *   node scripts/dias/register-policy.js [--registrar audit:sp.north] [--activator audit:cfo.north]
 *     [--bundle policies/dias-governance-policy-v1.json]
 *
 * Two different AuditMSP district heads are required. Safe to run again. This
 * writes to the ledger of the network the backend configuration points at.
 */

const path = require('path');
const fabric = require('../../backend/src/fabric/gateway');
const { DEFAULT_BUNDLE, registerAndActivatePolicy } = require('../../backend/src/dias/policyRegistration');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function identity(text) {
  const [org, fabricUser] = String(text).split(':');
  if (!org || !fabricUser) throw new Error(`identity must be org:user, got '${text}'`);
  return { org, fabricUser };
}

async function main() {
  const result = await registerAndActivatePolicy({
    ledger: fabric,
    registrar: identity(option('registrar', 'audit:sp.north')),
    activator: identity(option('activator', 'audit:cfo.north')),
    bundlePath: path.resolve(option('bundle', DEFAULT_BUNDLE)),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`register-policy failed: ${error.message}\n`);
  process.exit(1);
});
