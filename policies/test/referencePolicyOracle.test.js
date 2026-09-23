'use strict';

const assert = require('assert');
const path = require('path');
const test = require('node:test');

const { loadBundle } = require('../lib/bundle');
const {
  DENY_PREDICATES, evaluateReference, referenceReason,
} = require('../reference-oracle/referencePolicyOracle');

const ROOT = path.resolve(__dirname, '..', '..');
const { evaluate: legacyEvaluate } = require(
  path.join(ROOT, 'chaincode/crimerecords/lib/policy/policyEngine')
);
const { RANK_TABLE } = require(path.join(ROOT, 'chaincode/crimerecords/lib/policy/authority'));

const { bundle } = loadBundle();
const MSP_BY_ORGANIZATION = {
  police: 'PoliceMSP', forensics: 'ForensicsMSP', prosecution: 'ProsecutionMSP', court: 'CourtMSP',
};

function baseFacts(overrides = {}) {
  return {
    requester: {
      mspId: 'PoliceMSP', role: 'inspector', jurisdiction: 'district-north',
      clearance: 'high', credentialStatus: 'active', assignedToRequestedCase: true,
      ...overrides.requester,
    },
    resource: {
      recordType: 'fir', caseId: 'CASE-A', sensitivityLevel: 'medium', jurisdiction: 'district-north',
      sealed: false, juvenileFlag: false, victimProtectionFlag: false, ...overrides.resource,
    },
    request: { action: 'view', purpose: 'investigation', ...overrides.request },
  };
}

function legacyDecision(facts) {
  const { requester, resource, request } = facts;
  return legacyEvaluate(
    {
      credentialStatus: requester.credentialStatus, mspId: requester.mspId, role: requester.role,
      jurisdiction: requester.jurisdiction, clearance: requester.clearance,
      caseAssignments: requester.assignedToRequestedCase ? resource.caseId : 'CASE-OTHER',
    },
    { ...resource },
    request.action,
    { purpose: request.purpose }
  );
}

test('every precedence clause has an oracle predicate', () => {
  for (const ref of bundle.precedence.denyOrder) {
    assert.ok(DENY_PREDICATES[ref.split('@')[0]], `missing predicate for ${ref}`);
  }
});

test('oracle reproduces the retained engine on an exhaustive grid (sealed: ESCALATE -> DENY)', () => {
  let compared = 0;
  const roles = Object.keys(RANK_TABLE);
  const msps = [...Object.values(MSP_BY_ORGANIZATION), 'AuditMSP'];
  for (const role of roles) {
    for (const mspId of msps) {
      for (const action of bundle.vocabularies.actions) {
        for (const recordType of bundle.vocabularies.recordTypes) {
          for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
            for (const sameDistrict of [true, false]) {
              for (const assigned of [true, false]) {
                for (const clearance of ['low', 'medium', 'high']) {
                  for (const sensitivityLevel of ['low', 'high']) {
                    for (const credentialStatus of ['active', 'suspended']) {
                      for (const purpose of ['investigation', 'curiosity']) {
                        const facts = baseFacts({
                          requester: {
                            mspId, role, clearance, credentialStatus, assignedToRequestedCase: assigned,
                            jurisdiction: sameDistrict ? 'district-north' : 'district-south',
                          },
                          resource: {
                            recordType, sensitivityLevel,
                            sealed: Boolean(flags & 1), juvenileFlag: Boolean(flags & 2),
                            victimProtectionFlag: Boolean(flags & 4),
                          },
                          request: { action, purpose },
                        });
                        const reference = evaluateReference(bundle, facts);
                        const retained = legacyDecision(facts);
                        const expected = retained.decision === 'escalate' ? 'DENY' : retained.decision.toUpperCase();
                        assert.equal(reference.recommendation, expected);
                        assert.equal(reference.reason_code, retained.reasonCode);
                        compared += 1;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(compared > 100000, `compared ${compared} cases`);
});

test('ALLOW lists the permission and default clauses', () => {
  const result = evaluateReference(bundle, baseFacts());
  assert.equal(result.recommendation, 'ALLOW');
  assert.equal(result.reason_code, 'POLICY_SATISFIED');
  assert.deepEqual(result.policy_refs, ['GP-RBAC:C2@v1', 'GP-DEFAULT:C1@v1']);
  assert.match(referenceReason(bundle, baseFacts(), result), /no DENY clause applies/);
});

test('DENY lists every applicable clause in precedence order, first decisive', () => {
  const facts = baseFacts({
    requester: { jurisdiction: 'district-south', clearance: 'low', assignedToRequestedCase: false },
    resource: { sensitivityLevel: 'high' },
  });
  const result = evaluateReference(bundle, facts);
  assert.equal(result.reason_code, 'CROSS_JURISDICTION');
  assert.deepEqual(result.policy_refs, ['GP-JURIS:C1@v1', 'GP-ASSIGN:C1@v1', 'GP-CLEAR:C1@v1']);
  assert.match(referenceReason(bundle, facts, result), /Also applicable: GP-ASSIGN:C1@v1, GP-CLEAR:C1@v1\./);
});

test('sealed records outside the court are DENY with a court-review flag', () => {
  const result = evaluateReference(bundle, baseFacts({ resource: { sealed: true } }));
  assert.equal(result.recommendation, 'DENY');
  assert.equal(result.reason_code, 'SEALED_RECORD');
  assert.deepEqual(result.review_flags, ['SEALED_RECORD_COURT_REVIEW']);
  const court = evaluateReference(bundle, baseFacts({
    requester: { mspId: 'CourtMSP', role: 'judge' }, resource: { sealed: true },
  }));
  assert.deepEqual(court.review_flags, []);
});

test('unknown roles and organizations never pass the RBAC organization clause', () => {
  const unknownRole = evaluateReference(bundle, baseFacts({ requester: { role: 'auditor' } }));
  assert.equal(unknownRole.decisive_clause, 'GP-RBAC:C1@v1');
  const wrongOrganization = evaluateReference(bundle, baseFacts({ requester: { mspId: 'AuditMSP', role: 'sp' } }));
  assert.equal(wrongOrganization.decisive_clause, 'GP-RBAC:C1@v1');
});

test('unknown sensitivity is treated as high and unknown clearance satisfies nothing', () => {
  const unknownSensitivity = evaluateReference(bundle, baseFacts({
    requester: { clearance: 'medium' }, resource: { sensitivityLevel: 'secret' },
  }));
  assert.equal(unknownSensitivity.reason_code, 'INSUFFICIENT_CLEARANCE');
  const unknownClearance = evaluateReference(bundle, baseFacts({
    requester: { clearance: 'top' }, resource: { sensitivityLevel: 'low' },
  }));
  assert.equal(unknownClearance.reason_code, 'INSUFFICIENT_CLEARANCE');
});

test('missing facts fail loudly instead of defaulting', () => {
  const facts = baseFacts();
  delete facts.requester.assignedToRequestedCase;
  assert.throws(() => evaluateReference(bundle, facts), /missing assignedToRequestedCase/);
});
