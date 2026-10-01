'use strict';

// Run: node --test testbed/reuse/run.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { auditorDecision, auditorFor, isAutomaticGrant } = require('./run');
const { REQUEST_STATUS } = require(path.resolve(__dirname, '../../chaincode/crimerecords/lib/accessContract.js'));

const ok = (recommendation) => ({ generationStatus: 'OK', recommendation });

test('a model ALLOW is followed, whatever the approval set says', () => {
  assert.deepEqual(auditorDecision(ok('ALLOW'), false), { decision: 'FORCE_ALLOW' });
  assert.deepEqual(auditorDecision(ok('ALLOW'), true), { decision: 'FORCE_ALLOW' });
});

test('a model DENY is overridden only for an approved base request, and the override carries a reason', () => {
  const override = auditorDecision(ok('DENY'), true);
  assert.equal(override.decision, 'FORCE_ALLOW');
  assert.ok(override.reason && override.reason.length > 0);
  assert.deepEqual(auditorDecision(ok('DENY'), false), { decision: 'FORCE_DENY' });
});

test('an unusable recommendation is denied with a reason, even for an approved base request', () => {
  for (const recommendation of [null, {}, { generationStatus: 'FAILED' }, ok('UNAVAILABLE')]) {
    const decision = auditorDecision(recommendation, true);
    assert.equal(decision.decision, 'FORCE_DENY');
    assert.ok(decision.reason);
  }
});

test('south-district records go to the south SP, the rest to the requester\'s department head', () => {
  const south = { record: { jurisdiction: 'district-south' } };
  const north = { record: { jurisdiction: 'district-north' } };
  assert.equal(auditorFor(south, { org: 'court' }), 'sp.south');
  assert.equal(auditorFor(north, { org: 'court' }), 'dj.north');
  assert.equal(auditorFor(north, { org: 'police' }), 'sp.north');
  assert.equal(auditorFor(north, { org: 'forensics' }), 'cfo.north');
  assert.equal(auditorFor(north, { org: 'prosecution' }), 'dp.north');
});

test('an automatic grant is recognised with the status value the contract writes', () => {
  assert.equal(isAutomaticGrant({ processingPath: 'dynamic-authorization', status: REQUEST_STATUS.GRANTED }), true);
  assert.equal(isAutomaticGrant({ processingPath: 'auditor-review', status: REQUEST_STATUS.AWAITING_AUDITOR }), false);
  assert.equal(isAutomaticGrant({ processingPath: 'dynamic-authorization', status: REQUEST_STATUS.AWAITING_AUDITOR }), false);
  assert.equal(isAutomaticGrant({}), false);
});
