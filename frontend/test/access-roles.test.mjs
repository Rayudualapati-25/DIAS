/**
 * Navigation must match the chaincode.
 *
 * The sidebar is a convenience, not an authorisation boundary, but a screen shown
 * to someone the chaincode will refuse is a broken screen: every action on it
 * fails. These cases use the seeded demo identities and the chaincode's own role
 * tables, so a drift in either direction fails here instead of in a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  canAccess, canAdministerOfficers, canAdvanceCaseWorkflow, canAttachEvidence, canCreateCase,
  canTransferCustody, ADMINISTRATION_ORGS, ROLES_BY_ORG,
} from '../js/core/access.js';
import { moduleById } from '../js/modules/index.js';

const require = createRequire(import.meta.url);
const { DISTRICT_HEAD_ROLES, SEAL_AUTHORITY_ROLES } =
  require('../../chaincode/crimerecords/lib/policy/policyV1.js');
const { REVIEWER_MSPS, REVIEWER_ROLES } = require('../../chaincode/crimerecords/lib/auditContract.js');

const USERS = Object.freeze({
  inspSharma: { org: 'police', role: 'inspector' },
  constVerma: { org: 'police', role: 'constable' },
  ioKrishnan: { org: 'police', role: 'investigating-officer' },
  analystRao: { org: 'forensics', role: 'lab-analyst' },
  dirIyer: { org: 'forensics', role: 'lab-director' },
  ppMehta: { org: 'prosecution', role: 'public-prosecutor' },
  judgeRana: { org: 'court', role: 'judge' },
  clerkDas: { org: 'court', role: 'court-clerk' },
  spNorth: { org: 'audit', role: 'sp' },
  djNorth: { org: 'audit', role: 'district-judge' },
  cfoNorth: { org: 'audit', role: 'chief-forensic-officer' },
  ciCentral: { org: 'audit', role: 'circle-inspector' },
});

const visible = (moduleId, user) => canAccess(user, moduleById(moduleId).allow);
const whoSees = (moduleId) => Object.entries(USERS)
  .filter(([, user]) => visible(moduleId, user)).map(([name]) => name);

const MSP_BY_ORG = Object.freeze({
  police: 'PoliceMSP', forensics: 'ForensicsMSP', prosecution: 'ProsecutionMSP', court: 'CourtMSP', audit: 'AuditMSP',
});

test('the auditor console and officer administration are for AuditMSP district heads only', () => {
  assert.deepEqual(whoSees('auditor-review'), ['spNorth', 'djNorth', 'cfoNorth']);
  assert.deepEqual(whoSees('register-user'), ['spNorth', 'djNorth', 'cfoNorth']);
  for (const [name, user] of Object.entries(USERS)) {
    const expected = user.org === 'audit' && DISTRICT_HEAD_ROLES.includes(user.role);
    assert.equal(canAdministerOfficers(user), expected, name);
  }
});

test('audit screens follow AuditContract reviewer organisations and roles', () => {
  for (const moduleId of ['audit-trail', 'payload-integrity', 'access-log']) {
    for (const [name, user] of Object.entries(USERS)) {
      const expected = REVIEWER_MSPS.includes(MSP_BY_ORG[user.org]) && REVIEWER_ROLES.includes(user.role);
      assert.equal(visible(moduleId, user), expected, `${moduleId} for ${name}`);
    }
  }
  assert.deepEqual(whoSees('audit-trail'), ['judgeRana', 'spNorth', 'djNorth', 'cfoNorth']);
  assert.ok(SEAL_AUTHORITY_ROLES.includes('judge'));
});

test('filing, PDF uploads and case creation are police station duties', () => {
  assert.deepEqual(whoSees('file-record'), ['inspSharma', 'constVerma', 'ioKrishnan']);
  assert.deepEqual(whoSees('document-requests'), ['inspSharma', 'constVerma', 'ioKrishnan']);
  assert.equal(canCreateCase(USERS.inspSharma), true);
  assert.equal(canCreateCase(USERS.ioKrishnan), true);
  assert.equal(canCreateCase(USERS.constVerma), false);
  assert.equal(canCreateCase(USERS.ciCentral), false);
  assert.equal(canCreateCase(USERS.spNorth), false);
});

test('only the court seals, only forensics attaches evidence, and custody stays with its holders', () => {
  assert.deepEqual(whoSees('seal-record'), ['judgeRana']);
  assert.deepEqual(Object.entries(USERS).filter(([, user]) => canAttachEvidence(user)).map(([name]) => name),
    ['analystRao', 'dirIyer']);
  assert.equal(canTransferCustody(USERS.analystRao), true);
  assert.equal(canTransferCustody(USERS.spNorth), false);
});

test('case workflow is offered to the roles GovernanceContract accepts', () => {
  assert.equal(canAdvanceCaseWorkflow(USERS.ppMehta), true);
  assert.equal(canAdvanceCaseWorkflow(USERS.judgeRana), true);
  assert.equal(canAdvanceCaseWorkflow({ org: 'police', role: 'circle-inspector' }), true);
  assert.equal(canAdvanceCaseWorkflow(USERS.ciCentral), false);
  assert.equal(canAdvanceCaseWorkflow(USERS.clerkDas), false);
  assert.equal(canAdvanceCaseWorkflow(USERS.inspSharma), false);
});

test('requesting access and the decision log are open to every signed-in identity', () => {
  for (const [name, user] of Object.entries(USERS)) {
    assert.equal(visible('request-access', user), true, `request-access for ${name}`);
    assert.equal(visible('decision-log', user), true, `decision-log for ${name}`);
  }
});

test('a district head can register an officer into any department', () => {
  assert.deepEqual([...ADMINISTRATION_ORGS], ['police', 'forensics', 'prosecution', 'court', 'audit']);
  assert.deepEqual([...ROLES_BY_ORG.audit], [...DISTRICT_HEAD_ROLES]);
  assert.ok(ROLES_BY_ORG.police.includes('constable'));
});
