'use strict';

// LEGACY (SEAL / pre-DIAS): exercises retained modules that the DIAS runtime no longer
// loads and that deployCC.sh excludes from the chaincode package (see architectureGuard.test.js).

const { expect } = require('chai');
const chai = require('chai');
chai.use(require('chai-as-promised'));

const AccessContract = require('../../lib/accessContract');
const RecordContract = require('../../lib/recordContract');
const {
  buildRequestFingerprint,
  createDynamicAccessRuleAsset,
  fingerprintHash,
} = require('../../lib/policy/dynamicPolicy');
const { putJson } = require('../../lib/util/state');
const {
  buildMockContext, cloneInto, seedCase, CALLERS, RECORD_META,
} = require('../testHelpers');

const access = new AccessContract();
const records = new RecordContract();
const QUERY_TEXT = 'I need to view this FIR for investigation.';
const ENV = '{"action":"view","purpose":"investigation"}';

const baseInput = () => ({
  governed: {
    enrollmentId: 'insp.test',
    mspId: 'PoliceMSP',
    organization: 'police',
    role: 'inspector',
    rank: '3',
    station: 'PS-Central',
    jurisdiction: 'district-north',
    clearance: 'high',
    credentialStatus: 'active',
    caseAssignments: 'CASE-1',
  },
  record: {
    recordId: 'FIR-1',
    caseId: 'CASE-1',
    recordType: 'fir',
    sensitivityLevel: 'medium',
    jurisdiction: 'district-north',
    owningAgency: 'police',
    owningStation: 'PS-Central',
    sealed: false,
    juvenileFlag: false,
    witnessFlag: false,
    victimProtectionFlag: false,
  },
  requestContext: { action: 'view', purpose: 'investigation' },
});

function ruleFor(fingerprint, overrides = {}) {
  return createDynamicAccessRuleAsset({
    txId: 'TX-RULE',
    timestamp: '2026-09-09T00:00:00.000Z',
    auditor: {
      enrollmentId: 'sp.test', mspId: 'AuditMSP', role: 'sp', id: 'auditor-cert',
    },
    fingerprint,
    sourceRequestId: 'REQ-SOURCE',
    sourceRecommendationId: 'REC-SOURCE',
    sourceAuditorDecisionId: 'AUD-SOURCE',
    llmRecommendation: 'deny',
    auditorDecision: 'force-allow',
    ...overrides,
  });
}

async function requesterWorld(txId = 'TX-REQ') {
  const state = buildMockContext(CALLERS.inspector);
  await seedCase(state, 'CASE-1', { assignedUsers: [CALLERS.inspector.identityId] });
  await seedCase(state, 'CASE-2', { assignedUsers: [CALLERS.inspector.identityId] });
  await state.stub.putState(
    state.stub.createCompositeKey('user', [CALLERS.inspector.identityId]),
    Buffer.from(JSON.stringify({
      docType: 'user', userId: CALLERS.inspector.identityId,
      fabricUser: CALLERS.inspector.identityId, org: 'police',
      role: CALLERS.inspector.attrs.role, rank: CALLERS.inspector.attrs.rank,
      station: CALLERS.inspector.attrs.station,
      jurisdiction: CALLERS.inspector.attrs.jurisdiction,
      clearance: CALLERS.inspector.attrs.clearance,
      credentialStatus: 'active',
    }))
  );
  await records.CreateCaseRecord(state, 'FIR-1', JSON.stringify(RECORD_META));
  await records.CreateCaseRecord(state, 'FIR-2', JSON.stringify({
    ...RECORD_META,
    caseId: 'CASE-2',
    offChainReference: 'vault://police/FIR-2',
  }));
  const requester = buildMockContext({ ...CALLERS.inspector, txId });
  cloneInto(state, requester);
  return requester;
}

function withQuery(ctx, run) {
  ctx._setTransient(new Map([['query', Buffer.from(QUERY_TEXT, 'utf8')]]));
  return Promise.resolve(run()).finally(() => ctx._setTransient(new Map()));
}

async function seedRule(ctx, fingerprint, overrides = {}) {
  const rule = ruleFor(fingerprint, overrides);
  await putJson(
    ctx,
    ctx.stub.createCompositeKey('dynamicAccessRule', [rule.fingerprintHash]),
    rule
  );
  return rule;
}

describe('DIAS dynamic access policy', () => {
  describe('canonical request fingerprint', () => {
    it('is stable across record and case identifiers when properties and assignment match', () => {
      const first = baseInput();
      const second = baseInput();
      second.record.recordId = 'FIR-999';
      second.record.caseId = 'CASE-999';
      second.governed.caseAssignments = 'CASE-999';

      const a = buildRequestFingerprint(first);
      const b = buildRequestFingerprint(second);
      expect(a).to.deep.equal(b);
      expect(fingerprintHash(a)).to.equal(fingerprintHash(b));
      expect(JSON.stringify(a)).to.not.contain('FIR-1');
      expect(JSON.stringify(a)).to.not.contain('CASE-1');
    });

    it('changes when any governed match field changes', () => {
      const baseline = fingerprintHash(buildRequestFingerprint(baseInput()));
      const mutations = [
        (x) => { x.governed.enrollmentId = 'other.user'; },
        (x) => { x.governed.mspId = 'ForensicsMSP'; },
        (x) => { x.governed.organization = 'forensics'; },
        (x) => { x.governed.role = 'constable'; },
        (x) => { x.governed.rank = '4'; },
        (x) => { x.governed.station = 'PS-East'; },
        (x) => { x.governed.jurisdiction = 'district-south'; },
        (x) => { x.governed.clearance = 'medium'; },
        (x) => { x.governed.credentialStatus = 'suspended'; },
        (x) => { x.governed.caseAssignments = null; },
        (x) => { x.requestContext.action = 'export'; },
        (x) => { x.requestContext.purpose = 'prosecution'; },
        (x) => { x.record.recordType = 'case-diary'; },
        (x) => { x.record.sensitivityLevel = 'high'; },
        (x) => { x.record.jurisdiction = 'district-south'; },
        (x) => { x.record.owningAgency = 'court'; },
        (x) => { x.record.owningStation = 'PS-East'; },
        (x) => { x.record.sealed = true; },
        (x) => { x.record.juvenileFlag = true; },
        (x) => { x.record.witnessFlag = true; },
        (x) => { x.record.victimProtectionFlag = true; },
      ];

      for (const mutate of mutations) {
        const changed = baseInput();
        mutate(changed);
        expect(fingerprintHash(buildRequestFingerprint(changed))).to.not.equal(baseline);
      }
    });
  });

  describe('rule provenance', () => {
    it('creates a versioned active rule only for DENY to FORCE_ALLOW', () => {
      const fingerprint = buildRequestFingerprint(baseInput());
      const rule = ruleFor(fingerprint);
      expect(rule).to.include({
        docType: 'dynamicAccessRule', status: 'active', ruleVersion: 1,
        sourceRequestId: 'REQ-SOURCE', sourceRecommendationId: 'REC-SOURCE',
        sourceAuditorDecisionId: 'AUD-SOURCE', createdByUsername: 'sp.test',
      });
      expect(rule.fingerprint).to.deep.equal(fingerprint);
      expect(rule.fingerprintHash).to.equal(fingerprintHash(fingerprint));
      expect(() => ruleFor(fingerprint, { llmRecommendation: 'allow' }))
        .to.throw(/DENY recommendation/);
      expect(() => ruleFor(fingerprint, { auditorDecision: 'force-deny' }))
        .to.throw(/FORCE_ALLOW/);
      expect(() => ruleFor(fingerprint, { sourceRequestId: undefined }))
        .to.throw(/sourceRequestId/);
      expect(() => ruleFor(fingerprint, { timestamp: 'not-a-date' }))
        .to.throw(/timestamp/);
    });
  });
});
