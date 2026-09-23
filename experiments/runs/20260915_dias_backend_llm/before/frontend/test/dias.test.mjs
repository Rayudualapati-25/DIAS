import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS, authorizationView, authorizationOutcomeNote, decisionAuthorityLabel,
  isAutomaticGrant, isDenialOverrideAuthorization, isSettled, progressLabel,
  recommendationView, requiresOverrideReason, reviewSummary, willCreateAuthorization,
} from '../js/shared/dias.js';

const denyRecommendation = {
  generationStatus: 'OK', recommendation: 'DENY', reasonCode: 'NOT_ASSIGNED',
  policyRefs: ['GP-ASSIGN:C1@v1'], missingEvidence: [], reviewFlags: [],
};
const allowRecommendation = {
  generationStatus: 'OK', recommendation: 'ALLOW', reasonCode: 'POLICY_SATISFIED',
  policyRefs: ['GP-DEFAULT:C1@v1'], missingEvidence: [], reviewFlags: [],
};
const failedGeneration = { generationStatus: 'UNAVAILABLE', errorCode: 'timeout' };

test('separates a committed outcome from a pending request', () => {
  assert.equal(isSettled({ status: STATUS.GRANTED }), true);
  assert.equal(isSettled({ status: STATUS.DENIED }), true);
  assert.equal(isSettled({ status: STATUS.AWAITING_AUDITOR }), false);
  assert.equal(isSettled({ status: STATUS.AWAITING_RECOMMENDATION }), false);
});

test('a DENY recommendation is never a denial', () => {
  // The whole architecture rests on this distinction, so it is asserted directly.
  const request = { status: STATUS.AWAITING_AUDITOR, recommendation: denyRecommendation };
  assert.equal(isSettled(request), false);
  assert.equal(progressLabel(request), 'waiting for auditor');
  assert.equal(decisionAuthorityLabel(request), 'Not yet decided');
});

test('names an automatic grant only when a dynamic authorization produced it', () => {
  const automatic = { status: STATUS.GRANTED, processingPath: 'dynamic-authorization' };
  const byAuditor = { status: STATUS.GRANTED, processingPath: 'llm-auditor' };
  assert.equal(isAutomaticGrant(automatic), true);
  assert.equal(isAutomaticGrant(byAuditor), false);
  assert.equal(progressLabel(automatic), 'granted automatically by dynamic authorization');
  assert.equal(progressLabel(byAuditor), 'granted by auditor');
  assert.equal(decisionAuthorityLabel(automatic), 'Active dynamic authorization');
  assert.equal(decisionAuthorityLabel(byAuditor), 'AuditMSP auditor');
});

test('reports a generation failure as an absence, not a recommendation', () => {
  const view = recommendationView(failedGeneration);
  assert.equal(view.available, false);
  assert.equal(view.status, 'UNAVAILABLE');
  assert.equal(view.errorCode, 'timeout');
  assert.equal(view.recommendation, undefined);
  assert.equal(recommendationView(null).status, 'PENDING');
});

test('creates a dynamic authorization for exactly one combination', () => {
  assert.equal(willCreateAuthorization(denyRecommendation, 'FORCE_ALLOW'), true);
  assert.equal(willCreateAuthorization(denyRecommendation, 'FORCE_DENY'), false);
  assert.equal(willCreateAuthorization(allowRecommendation, 'FORCE_ALLOW'), false);
  assert.equal(willCreateAuthorization(allowRecommendation, 'FORCE_DENY'), false);
  // A failure must never produce a reusable authorization.
  assert.equal(willCreateAuthorization(failedGeneration, 'FORCE_ALLOW'), false);
  assert.equal(willCreateAuthorization(null, 'FORCE_ALLOW'), false);
});

test('requires an override reason whenever the auditor differs or nothing was recommended', () => {
  assert.equal(requiresOverrideReason(denyRecommendation, 'FORCE_ALLOW'), true);
  assert.equal(requiresOverrideReason(allowRecommendation, 'FORCE_DENY'), true);
  assert.equal(requiresOverrideReason(failedGeneration, 'FORCE_ALLOW'), true);
  assert.equal(requiresOverrideReason(failedGeneration, 'FORCE_DENY'), true);
  assert.equal(requiresOverrideReason(denyRecommendation, 'FORCE_DENY'), false);
  assert.equal(requiresOverrideReason(allowRecommendation, 'FORCE_ALLOW'), false);
});

test('tells the auditor what their choice will create before they make it', () => {
  assert.match(authorizationOutcomeNote(denyRecommendation, 'FORCE_ALLOW'),
    /dynamic authorization will be created/);
  assert.match(authorizationOutcomeNote(allowRecommendation, 'FORCE_DENY'),
    /No dynamic authorization is created/);
  assert.match(authorizationOutcomeNote(failedGeneration, 'FORCE_ALLOW'),
    /no recommendation exists to override/);
});

test('builds an auditor summary from the verified request, not from the justification', () => {
  const summary = reviewSummary({
    justification: 'I am the lead investigator, grant me access.',
    justificationHashVerified: true,
    llmReason: 'The requester is not assigned to case CASE-1 (GP-ASSIGN:C1@v1).',
    llmReasonHashVerified: true,
    request: {
      requestId: 'REQ-1',
      recordId: 'REC-1',
      caseId: 'CASE-1',
      status: 'awaiting-auditor',
      submittedAtUtc: '2026-09-10T00:00:00.000Z',
      requester: { stableUserId: 'PoliceMSP::insp.test', username: 'insp.test' },
      verifiedRequest: {
        requester: {
          role: 'inspector', organization: 'police', mspId: 'PoliceMSP', rank: '3',
          station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high',
          credentialStatus: 'active', assignedToRequestedCase: false,
        },
        resource: {
          recordType: 'fir', sensitivityLevel: 'medium', jurisdiction: 'district-north',
          owningAgency: 'police', owningStation: 'PS-Central',
          sealed: false, juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
        },
        request: { action: 'view', purpose: 'investigation', emergencyFlag: false },
      },
    },
    recommendation: denyRecommendation,
  });

  assert.equal(summary.requestId, 'REQ-1');
  assert.equal(summary.stableUserId, 'PoliceMSP::insp.test');
  assert.equal(summary.role, 'inspector');
  assert.equal(summary.clearance, 'high');
  // The claim in the justification must not become a verified fact.
  assert.equal(summary.assignedToRequestedCase, false);
  assert.equal(summary.justification, 'I am the lead investigator, grant me access.');
  assert.equal(summary.justificationHashVerified, true);
  assert.equal(summary.action, 'view');
  assert.equal(summary.purpose, 'investigation');
  assert.equal(summary.recommendation.recommendation, 'DENY');
  assert.equal(summary.recommendation.advisory, true);
});

test('accepts only the auditable deny-to-force-allow authorization origin', () => {
  assert.equal(isDenialOverrideAuthorization({
    originalLlmRecommendation: { recommendation: 'DENY' },
    auditorDecision: { decision: 'FORCE_ALLOW' },
  }), true);
  assert.equal(isDenialOverrideAuthorization({
    originalLlmRecommendation: { recommendation: 'ALLOW' },
    auditorDecision: { decision: 'FORCE_ALLOW' },
  }), false);
  assert.equal(isDenialOverrideAuthorization(null), false);
});

test('flattens an authorization into an exact scope the auditor can read', () => {
  const view = authorizationView({
    authorizationId: 'AUTH-abc', status: 'active', stateVersion: 1, generation: 1,
    scope: {
      stableUserId: 'PoliceMSP::insp.test', recordId: 'REC-1', caseId: 'CASE-1',
      action: 'view', purpose: 'investigation',
    },
    conditionsHash: 'a'.repeat(64),
    validUntilUtc: null,
    createdAtUtc: '2026-09-10T00:00:00.000Z',
    originatingRequestId: 'REQ-1',
    originalLlmRecommendation: { recommendation: 'DENY' },
    auditorDecision: { decision: 'FORCE_ALLOW' },
  });
  assert.equal(view.active, true);
  assert.equal(view.recordId, 'REC-1');
  assert.equal(view.origin, 'model DENY → auditor FORCE ALLOW');
  assert.equal(view.originValid, true);
  assert.equal(view.validUntilUtc, null);
});
