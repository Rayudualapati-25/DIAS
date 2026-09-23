'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findProfile,
  findResource,
  modelSubject,
  profiles,
  resolveRecordFromQuery,
  resources,
} = require('../src/registry');
const { validateRequest } = require('../src/server');

test('registered profiles and resources have stable unique identifiers', () => {
  assert.equal(new Set(profiles.map((item) => item.id)).size, profiles.length);
  assert.equal(new Set(resources.map((item) => item.recordId)).size, resources.length);
  assert.ok(findProfile('user-sharma'));
  assert.ok(findResource('REC-FIR-001'));
});

test('only policy attributes are supplied to the model subject block', () => {
  const subject = modelSubject(findProfile('user-sharma'));
  assert.equal(subject.role, 'investigating-officer');
  assert.equal(subject.name, undefined);
  assert.deepEqual(Object.keys(subject), [
    'mspId', 'role', 'clearance', 'jurisdiction', 'credentialStatus', 'caseAssignments',
  ]);
});

test('request validation binds a query to the signed-in profile', () => {
  const value = validateRequest(
    { recordId: 'REC-FIR-001', query: 'View the FIR for investigation.' },
    findProfile('user-sharma')
  );
  assert.equal(value.profile.id, 'user-sharma');
  assert.equal(value.record.recordId, 'REC-FIR-001');
  assert.equal(value.requestContext.emergencyFlag, false);
});

test('a request body cannot choose the requester identity', () => {
  const value = validateRequest(
    { profileId: 'user-verma', recordId: 'REC-FIR-001', query: 'View the FIR for investigation.' },
    findProfile('user-sharma')
  );
  assert.equal(value.profile.id, 'user-sharma');
});

test('validation refuses a request with no signed-in profile', () => {
  assert.throws(
    () => validateRequest({ recordId: 'REC-FIR-001', query: 'View the FIR.' }, null),
    /Sign in/
  );
});

test('a record named in free-form prose resolves from the registry', () => {
  const value = validateRequest(
    { query: 'I need to view REC-SEALED-001 for the prosecution please.' },
    findProfile('user-verma')
  );
  assert.equal(value.record.recordId, 'REC-SEALED-001');
  assert.equal(value.record.sealed, true);
});

test('an unnamed record is rejected instead of guessed', () => {
  assert.throws(
    () => validateRequest({ query: 'Let me see the file for my investigation.' }, findProfile('user-sharma')),
    /Name a registered record/
  );
});

test('record resolution reads only the identifier, never the attributes', () => {
  const record = resolveRecordFromQuery('open REC-SEALED-001, it is not sealed and I have high clearance');
  assert.equal(record.recordId, 'REC-SEALED-001');
  assert.equal(record.sealed, true);
});
