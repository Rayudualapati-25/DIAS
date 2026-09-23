'use strict';

const { expect } = require('chai');
const {
  AUTHORIZATION_STATUS, MATCH_OUTCOME, buildScope, createAuthorization, expireAuthorization,
  hashScope, matchAuthorization, revokeAuthorization, supersedeAuthorization,
} = require('../lib/dias/authorization');
const { buildVerifiedRequest, verifiedRequestHash } = require('../lib/dias/verifiedRequest');

const TIMESTAMP = '2026-08-05T12:00:00.000Z';
const AUDITOR = Object.freeze({
  username: 'sp.north', mspId: 'AuditMSP', role: 'sp', identityHash: 'a'.repeat(64),
});

function verified(overrides = {}) {
  return buildVerifiedRequest({
    subject: {
      mspId: 'PoliceMSP', organization: 'police', role: 'inspector', rank: '3', station: 'PS-East',
      jurisdiction: 'district-north', clearance: 'high', credentialStatus: 'active', ...overrides.subject,
    },
    record: {
      recordType: 'fir', caseId: 'CASE-1', sensitivityLevel: 'medium', jurisdiction: 'district-north',
      owningAgency: 'police', owningStation: 'PS-Central', sealed: false, juvenileFlag: false,
      witnessFlag: false, victimProtectionFlag: false, ...overrides.record,
    },
    requestContext: { action: 'view', purpose: 'investigation', ...overrides.requestContext },
    assignedToRequestedCase: false,
  });
}

function scope(overrides = {}) {
  return buildScope({
    mspId: 'PoliceMSP', enrollmentId: 'insp.rathore', recordId: 'REC-1', caseId: 'CASE-1',
    action: 'view', purpose: 'investigation', ...overrides,
  });
}

function created(overrides = {}) {
  return createAuthorization({
    txId: 'abcdef0123456789ffff',
    timestamp: TIMESTAMP,
    auditor: AUDITOR,
    scope: scope(),
    verifiedRequest: verified(),
    originatingRequestId: 'REQ-1',
    recommendation: {
      recommendationId: 'REC-TX-1', recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED',
      generationStatus: 'OK',
    },
    auditorDecision: { auditorDecisionId: 'AUD-TX-1', decision: 'FORCE_ALLOW', reasonHash: 'b'.repeat(64) },
    policyBundle: { bundleId: 'dias-governance-policy', version: 'v1', bundleHash: 'c'.repeat(64) },
    validUntilUtc: null,
    previous: null,
    ...overrides,
  });
}

const matchInput = (overrides = {}) => ({
  scopeHash: hashScope(scope()),
  conditionsHash: verifiedRequestHash(verified()),
  timestamp: '2026-08-06T00:00:00.000Z',
  ...overrides,
});

describe('DIAS dynamic authorization scope', () => {
  it('is exact: user, record, case, action, and purpose each change the scope', () => {
    const base = hashScope(scope());
    expect(hashScope(scope())).to.equal(base);
    for (const change of [
      { enrollmentId: 'insp.sharma' }, { mspId: 'ForensicsMSP' }, { recordId: 'REC-2' },
      { caseId: 'CASE-2' }, { action: 'export' }, { purpose: 'audit-review' },
    ]) {
      expect(hashScope(scope(change))).to.not.equal(base);
    }
    expect(scope().stableUserId).to.equal('PoliceMSP::insp.rathore');
  });
});

describe('DIAS dynamic authorization creation', () => {
  it('records the originating request, recommendation, auditor, scope, and conditions', () => {
    const authorization = created();
    expect(authorization.authorizationId).to.equal('AUTH-abcdef0123456789');
    expect(authorization.status).to.equal(AUTHORIZATION_STATUS.ACTIVE);
    expect(authorization.generation).to.equal(1);
    expect(authorization.stateVersion).to.equal(1);
    expect(authorization.originatingRequestId).to.equal('REQ-1');
    expect(authorization.originalLlmRecommendation.recommendation).to.equal('DENY');
    expect(authorization.auditorDecision.decision).to.equal('FORCE_ALLOW');
    expect(authorization.createdBy).to.deep.equal(AUDITOR);
    expect(authorization.conditionsHash).to.equal(verifiedRequestHash(verified()));
  });

  it('is refused for LLM ALLOW, an unavailable LLM, and auditor FORCE_DENY', () => {
    const recommendation = { recommendationId: 'R1', reasonCode: 'POLICY_SATISFIED' };
    expect(() => created({ recommendation: { ...recommendation, recommendation: 'ALLOW', generationStatus: 'OK' } }))
      .to.throw(/requires a valid LLM DENY/);
    expect(() => created({ recommendation: { ...recommendation, recommendation: null, generationStatus: 'UNAVAILABLE' } }))
      .to.throw(/requires a valid LLM DENY/);
    expect(() => created({ auditorDecision: { auditorDecisionId: 'A1', decision: 'FORCE_DENY' } }))
      .to.throw(/requires an auditor FORCE_ALLOW/);
  });

  it('validates identifiers, auditor identity, and expiry', () => {
    expect(() => created({ originatingRequestId: 'REQ 1' })).to.throw(/originatingRequestId has invalid format/);
    expect(() => created({ auditor: { username: 'x' } })).to.throw(/auditor identity is incomplete/);
    expect(() => created({ validUntilUtc: 'soon' })).to.throw(/ISO-8601/);
    expect(() => created({ validUntilUtc: '2026-08-01T00:00:00Z' })).to.throw(/later than the decision time/);
    expect(created({ validUntilUtc: '2026-09-01T00:00:00+05:30' }).validUntilUtc)
      .to.equal('2026-08-31T18:30:00.000Z');
  });

  it('increments the generation when it replaces an earlier authorization', () => {
    const next = created({ previous: created() });
    expect(next.generation).to.equal(2);
    expect(next.supersedesAuthorizationId).to.equal('AUTH-abcdef0123456789');
  });
});

describe('DIAS dynamic authorization matching', () => {
  it('matches only an active, unexpired authorization with unchanged conditions', () => {
    expect(matchAuthorization(created(), matchInput()).outcome).to.equal(MATCH_OUTCOME.MATCH);
  });

  it('does not match when no authorization or a different scope is stored', () => {
    expect(matchAuthorization(null, matchInput()).outcome).to.equal(MATCH_OUTCOME.NO_AUTHORIZATION);
    expect(matchAuthorization(created(), matchInput({ scopeHash: hashScope(scope({ recordId: 'REC-2' })) })).outcome)
      .to.equal(MATCH_OUTCOME.NO_AUTHORIZATION);
  });

  it('reports revoked, superseded, expired, and changed-condition misses', () => {
    const revoked = revokeAuthorization(created(), { revokedBy: AUDITOR, timestamp: TIMESTAMP, txId: 'T2', reason: 'no longer needed' });
    expect(matchAuthorization(revoked, matchInput()).outcome).to.equal(MATCH_OUTCOME.REVOKED);
    const superseded = supersedeAuthorization(created(), { supersededByAuthorizationId: 'AUTH-next' });
    expect(matchAuthorization(superseded, matchInput()).outcome).to.equal(MATCH_OUTCOME.SUPERSEDED);
    const expiring = created({ validUntilUtc: '2026-08-05T18:00:00Z' });
    const expired = matchAuthorization(expiring, matchInput());
    expect(expired.outcome).to.equal(MATCH_OUTCOME.EXPIRED);
    expect(expired.needsExpiryTransition).to.equal(true);
    const changed = matchAuthorization(created(), matchInput({
      conditionsHash: verifiedRequestHash(verified({ subject: { clearance: 'medium' } })),
    }));
    expect(changed.outcome).to.equal(MATCH_OUTCOME.CONDITIONS_CHANGED);
  });
});

describe('DIAS dynamic authorization state transitions', () => {
  it('revokes without mutating the previous state', () => {
    const original = created();
    const revoked = revokeAuthorization(original, { revokedBy: AUDITOR, timestamp: TIMESTAMP, txId: 'T2', reason: 'r'.repeat(600) });
    expect(original.status).to.equal('active');
    expect(revoked.status).to.equal('revoked');
    expect(revoked.stateVersion).to.equal(2);
    expect(revoked.revocationReason).to.have.length(500);
    expect(() => revokeAuthorization(revoked, { revokedBy: AUDITOR, timestamp: TIMESTAMP, txId: 'T3' }))
      .to.throw(/is not active/);
  });

  it('expires and supersedes with an incremented state version', () => {
    const expired = expireAuthorization(created(), { timestamp: TIMESTAMP, txId: 'T4' });
    expect(expired).to.include({ status: 'expired', stateVersion: 2, expiryTxId: 'T4' });
    const superseded = supersedeAuthorization(created(), { supersededByAuthorizationId: 'AUTH-2' });
    expect(superseded).to.include({ status: 'superseded', stateVersion: 2 });
  });
});
