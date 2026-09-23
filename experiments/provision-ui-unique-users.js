'use strict';

/**
 * Provision the synthetic Fabric identities used by the distinct-user latency
 * experiment. Registration, ledger admission, and case assignment are setup
 * operations and are never included in the measured latency samples.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ca = require('../backend/src/fabric/ca');
const fabric = require('../backend/src/fabric/gateway');
const users = require('../backend/src/fabric/users');

const REPO_ROOT = path.resolve(__dirname, '..');
const TOTAL_USERS = Number(process.env.TOTAL_USERS || 100);
const USER_PREFIX = process.env.USER_PREFIX || 'latuser';
const ORG = 'police';
const REGISTRAR = 'sho.reddy';
const CASE_ID = 'CASE-2026-001';

if (!Number.isInteger(TOTAL_USERS) || TOTAL_USERS < 1 || TOTAL_USERS > 500) {
  throw new Error('TOTAL_USERS must be an integer from 1 through 500');
}
if (!/^[A-Za-z0-9_-]{1,50}$/.test(USER_PREFIX)) {
  throw new Error('USER_PREFIX must contain only letters, digits, underscore, or hyphen');
}

const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = `${runStamp}_ui_unique_user_provisioning`;
const runDir = path.join(REPO_ROOT, 'experiments', 'runs', runId);
fs.mkdirSync(runDir, { recursive: true });
const logPath = path.join(runDir, 'provisioning.log');

function log(message = '') {
  const line = String(message);
  process.stdout.write(`${line}\n`);
  fs.appendFileSync(logPath, `${line}\n`);
}

function userId(index) {
  return `${USER_PREFIX}.${String(index).padStart(3, '0')}`;
}

function definition(index) {
  const username = userId(index);
  return Object.freeze({
    username,
    displayName: `Synthetic Latency User ${String(index).padStart(3, '0')}`,
    org: ORG,
    role: 'inspector',
    rank: '3',
    station: 'PS-Central',
    jurisdiction: 'district-north',
    badgeId: `LAT${String(index).padStart(3, '0')}`,
    clearance: 'high',
    caseAssignments: [CASE_ID],
    credentialStatus: 'active',
    synthetic: true,
  });
}

function certificateAttributes(item) {
  return {
    role: item.role,
    rank: item.rank,
    station: item.station,
    jurisdiction: item.jurisdiction,
    badgeId: item.badgeId,
    clearance: item.clearance,
    credentialStatus: item.credentialStatus,
    caseAssignments: item.caseAssignments.join('|'),
  };
}

function ledgerProfile(item) {
  return {
    displayName: item.displayName,
    org: item.org,
    role: item.role,
    fabricUser: item.username,
    departmentId: item.org,
    rank: item.rank,
    station: item.station,
    jurisdiction: item.jurisdiction,
    clearance: item.clearance,
    caseAssignments: item.caseAssignments,
    credentialStatus: item.credentialStatus,
  };
}

function assertMatchingProfile(expected, actual) {
  const fields = [
    'displayName', 'org', 'role', 'fabricUser', 'departmentId', 'rank',
    'station', 'jurisdiction', 'clearance', 'credentialStatus',
  ];
  for (const field of fields) {
    const expectedValue = field === 'fabricUser'
      ? expected.username
      : field === 'departmentId' ? expected.org : expected[field];
    if (actual[field] !== expectedValue) {
      throw new Error(`${expected.username}: existing ledger field '${field}' does not match`);
    }
  }
  const actualCases = Array.isArray(actual.caseAssignments) ? actual.caseAssignments : [];
  if (JSON.stringify(actualCases) !== JSON.stringify(expected.caseAssignments)) {
    throw new Error(`${expected.username}: existing ledger caseAssignments do not match`);
  }
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main() {
  const definitions = Array.from({ length: TOTAL_USERS }, (_, index) => definition(index + 1));
  const config = {
    experiment: 'distinct enrolled Fabric user provisioning',
    runId,
    generatedAtUtc: new Date().toISOString(),
    totalUsers: TOTAL_USERS,
    userPrefix: USER_PREFIX,
    organization: ORG,
    registrar: REGISTRAR,
    assignedCase: CASE_ID,
    syntheticOnly: true,
    enrollmentSecretsPersisted: false,
    sourceSha256: sha256(__filename),
  };
  fs.writeFileSync(path.join(runDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'users.json'), `${JSON.stringify(definitions, null, 2)}\n`);

  log(`Provisioning run: ${runId}`);
  log(`Target: ${TOTAL_USERS} distinct synthetic PoliceMSP identities`);

  const existingUsers = await users.list(ORG, REGISTRAR);
  const existingById = new Map(existingUsers.map((item) => [item.userId, item]));
  let enrolledNow = 0;
  let createdNow = 0;
  let reused = 0;

  for (const [offset, item] of definitions.entries()) {
    const existing = existingById.get(item.username);
    const enrolled = ca.isEnrolled(ORG, item.username);
    if (existing) {
      assertMatchingProfile(item, existing);
      if (!enrolled) {
        throw new Error(`${item.username}: ledger profile exists but enrollment material is missing`);
      }
      reused += 1;
    } else {
      if (!enrolled) {
        await ca.registerAndEnroll({
          org: ORG,
          fabricUser: item.username,
          attributes: certificateAttributes(item),
        });
        enrolledNow += 1;
      }
      await users.create(ORG, REGISTRAR, item.username, ledgerProfile(item));
      createdNow += 1;
    }
    log(`[${String(offset + 1).padStart(3, '0')}/${TOTAL_USERS}] ready ${item.username}`);
  }

  let caseAsset = await fabric.evaluate(
    ORG, REGISTRAR, 'GovernanceContract', 'ReadCase', CASE_ID
  );
  const assigned = new Set(Array.isArray(caseAsset.assignedUsers) ? caseAsset.assignedUsers : []);
  let assignedNow = 0;
  for (const [offset, item] of definitions.entries()) {
    if (!assigned.has(item.username)) {
      caseAsset = await fabric.submit(
        ORG, REGISTRAR, 'GovernanceContract', 'AssignCaseUser', CASE_ID, item.username
      );
      assigned.add(item.username);
      assignedNow += 1;
    }
    log(`[${String(offset + 1).padStart(3, '0')}/${TOTAL_USERS}] assigned ${item.username}`);
  }

  const finalUsers = await users.list(ORG, REGISTRAR);
  const finalById = new Map(finalUsers.map((item) => [item.userId, item]));
  const finalCase = await fabric.evaluate(
    ORG, REGISTRAR, 'GovernanceContract', 'ReadCase', CASE_ID
  );
  const finalAssignments = new Set(finalCase.assignedUsers || []);
  const checks = definitions.map((item) => ({
    username: item.username,
    enrolled: ca.isEnrolled(ORG, item.username),
    onLedger: finalById.has(item.username),
    assignedToCase: finalAssignments.has(item.username),
  }));
  const failedChecks = checks.filter((item) => (
    !item.enrolled || !item.onLedger || !item.assignedToCase
  ));
  const summary = {
    runId,
    completedAtUtc: new Date().toISOString(),
    requestedUsers: TOTAL_USERS,
    readyUsers: checks.length - failedChecks.length,
    enrolledNow,
    createdOnLedgerNow: createdNow,
    alreadyReady: reused,
    assignedToCaseNow: assignedNow,
    failedChecks,
    success: failedChecks.length === 0,
  };
  fs.writeFileSync(path.join(runDir, 'verification.json'), `${JSON.stringify(checks, null, 2)}\n`);
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (failedChecks.length > 0) {
    throw new Error(`${failedChecks.length} provisioned identity checks failed`);
  }

  log(`Provisioning complete: ${TOTAL_USERS}/${TOTAL_USERS} identities verified.`);
  log(`Artifacts: ${runDir}`);

  const artifactNames = [
    'config.json', 'users.json', 'verification.json', 'summary.json', 'provisioning.log',
  ];
  const manifest = {
    runId,
    generatedAtUtc: new Date().toISOString(),
    artifacts: Object.fromEntries(artifactNames.map((name) => [name, {
      bytes: fs.statSync(path.join(runDir, name)).size,
      sha256: sha256(path.join(runDir, name)),
    }])),
  };
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log(`FAILED: ${String(error.stack || error)}`);
    process.exit(1);
  });
