import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_AGREEMENT, STATUS, accessDecisionView, agreementLabel, authorizationView, authorizationOutcomeNote,
  decisionAvailability, decisionFailureView, offChainVerificationRows,
  decisionAuthorityLabel, isAutomaticGrant, isDenialOverrideAuthorization, isSettled,
  llmAgreement, progressLabel, recommendationView, requiresOverrideReason, reviewSummary,
  willCreateAuthorization,
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
  assert.equal(Object.values(STATUS).includes('awaiting-recommendation'), false);
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
  const byAuditor = { status: STATUS.GRANTED, processingPath: 'auditor-review' };
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
  assert.equal(recommendationView(null).status, 'NOT_GENERATED');
});

test('says a recommendation is being prepared while the backend asks the LLM', () => {
  const view = recommendationView(null, 'pending');
  assert.equal(view.available, false);
  assert.equal(view.pending, true);
  assert.equal(view.label, 'being prepared');
});

test('derives the LLM agreement the ledger will record', () => {
  assert.equal(llmAgreement(allowRecommendation, 'FORCE_ALLOW'), LLM_AGREEMENT.AGREED);
  assert.equal(llmAgreement(denyRecommendation, 'FORCE_DENY'), LLM_AGREEMENT.AGREED);
  assert.equal(llmAgreement(denyRecommendation, 'FORCE_ALLOW'), LLM_AGREEMENT.NOT_AGREED);
  assert.equal(llmAgreement(allowRecommendation, 'FORCE_DENY'), LLM_AGREEMENT.NOT_AGREED);
  assert.equal(llmAgreement(failedGeneration, 'FORCE_ALLOW'), LLM_AGREEMENT.NO_RECOMMENDATION);
  assert.equal(llmAgreement(null, 'FORCE_DENY'), LLM_AGREEMENT.NO_RECOMMENDATION);
  assert.equal(agreementLabel('NOT_AGREED'), 'did not agree with the LLM');
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
    recommendationState: 'ready',
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
        request: { action: 'view', purpose: 'investigation' },
      },
      requesterClaims: { emergencyDeclared: true },
    },
    recommendation: {
      ...denyRecommendation,
      reason: 'The requester is not assigned to case CASE-1 (GP-ASSIGN:C1@v1).',
    },
  });

  assert.equal(summary.requestId, 'REQ-1');
  assert.equal(summary.stableUserId, 'PoliceMSP::insp.test');
  assert.equal(summary.role, 'inspector');
  assert.equal(summary.clearance, 'high');
  // The claim in the justification must not become a verified fact.
  assert.equal(summary.assignedToRequestedCase, false);
  assert.equal(summary.justification, 'I am the lead investigator, grant me access.');
  assert.equal(summary.llmReason, 'The requester is not assigned to case CASE-1 (GP-ASSIGN:C1@v1).');
  assert.equal(summary.recommendationState, 'ready');
  assert.equal(summary.action, 'view');
  assert.equal(summary.purpose, 'investigation');
  assert.equal(summary.recommendation.recommendation, 'DENY');
  assert.equal(summary.recommendation.advisory, true);
  // A declared emergency is shown as the requester's claim, kept apart from the facts.
  assert.equal(summary.emergencyDeclared, true);
  assert.equal('emergencyFlag' in summary, false);
});

test('accepts only the auditable deny-to-force-allow authorization origin', () => {
  assert.equal(isDenialOverrideAuthorization({
    auditorDecision: { decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' },
  }), true);
  assert.equal(isDenialOverrideAuthorization({
    auditorDecision: { decision: 'FORCE_ALLOW', llmAgreement: 'AGREED' },
  }), false);
  assert.equal(isDenialOverrideAuthorization({
    auditorDecision: { decision: 'FORCE_DENY', llmAgreement: 'NOT_AGREED' },
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
    auditorDecision: { decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED' },
  });
  assert.equal(view.active, true);
  assert.equal(view.recordId, 'REC-1');
  assert.equal(view.origin, 'model DENY → auditor FORCE ALLOW');
  assert.equal(view.originValid, true);
  assert.equal(view.validUntilUtc, null);
});

test('describes a committed access decision by who decided it, never by the model', () => {
  const byAuditor = accessDecisionView({
    decisionId: 'OUTCOME-1', requestId: 'REQ-1', recordId: 'REC-1', status: 'granted', decision: 'allow',
    action: 'view', purpose: 'investigation', decisionAuthority: 'auditor',
    auditorDecisionId: 'AUDIT-1', authorizationId: null, createdAtUtc: '2026-09-15T10:00:00.000Z',
  });
  assert.equal(byAuditor.outcomeLabel, 'GRANTED');
  assert.equal(byAuditor.authorityLabel, 'AuditMSP auditor');
  assert.equal(byAuditor.automatic, false);
  assert.equal(byAuditor.auditorDecisionId, 'AUDIT-1');
  assert.equal(byAuditor.releasesMetadata, true);

  const automatic = accessDecisionView({
    decisionId: 'OUTCOME-2', requestId: 'REQ-2', status: 'granted', action: 'export',
    decisionAuthority: 'dynamic-authorization', authorizationId: 'AUTH-1',
  });
  assert.equal(automatic.authorityLabel, 'Active dynamic authorization');
  assert.equal(automatic.authorizationId, 'AUTH-1');
  // Only a view grant opens case-file metadata; other actions have no release path.
  assert.equal(automatic.releasesMetadata, false);

  const denied = accessDecisionView({ decisionId: 'OUTCOME-3', status: 'denied', action: 'view', decisionAuthority: 'auditor' });
  assert.equal(denied.outcomeLabel, 'DENIED');
  assert.equal(denied.releasesMetadata, false);
  assert.equal(JSON.stringify(denied).includes('recommendation'), false);
});

test('says who may decide a request, before the auditor presses anything', () => {
  const review = (username, state = 'ready') => ({
    request: { requestId: 'REQ-1', requester: { username } },
    recommendationState: state,
  });

  const other = decisionAvailability(review('insp.sharma'), 'sp.north');
  assert.equal(other.allowed, true);
  assert.equal(other.reason, null);

  // The chaincode refuses a decision by the identity that raised the request.
  const own = decisionAvailability(review('sp.north'), 'sp.north');
  assert.equal(own.allowed, false);
  assert.equal(own.reason, 'own-request');
  assert.match(own.message, /raised this request/i);

  const pending = decisionAvailability(review('insp.sharma', 'pending'), 'sp.north');
  assert.equal(pending.allowed, false);
  assert.equal(pending.reason, 'recommendation-pending');
  assert.match(pending.message, /being prepared/i);

  // An unknown viewer is never told a decision is available.
  assert.equal(decisionAvailability(review('insp.sharma'), '').allowed, false);
  assert.equal(decisionAvailability(null, 'sp.north').allowed, false);
});

test('treats expired and cancelled requests as closed without any decision', async () => {
  const dias = await import('../js/shared/dias.js');
  for (const status of ['expired', 'cancelled']) {
    assert.equal(dias.isSettled({ status }), true, status);
    assert.equal(dias.isAutomaticGrant({ status }), false, status);
  }
  assert.equal(dias.progressLabel({ status: 'expired' }), 'expired before an auditor decided');
  assert.equal(dias.progressLabel({ status: 'cancelled' }), 'cancelled by the requester');
  assert.equal(dias.decisionAuthorityLabel({ status: 'expired' }), 'Nobody: the review deadline passed');
  assert.equal(dias.decisionAuthorityLabel({ status: 'cancelled' }), 'Nobody: the requester cancelled');
  const expired = dias.accessDecisionView({ status: 'expired', decisionAuthority: 'review-deadline', action: 'view' });
  assert.equal(expired.outcomeLabel, 'EXPIRED');
  assert.equal(expired.granted, false);
  assert.equal(expired.releasesMetadata, false);
  assert.equal(expired.authorityLabel, 'Review deadline');
  const cancelled = dias.accessDecisionView({ status: 'cancelled', decisionAuthority: 'requester', action: 'view' });
  assert.equal(cancelled.outcomeLabel, 'CANCELLED');
  assert.equal(cancelled.authorityLabel, 'Requester');
});

test('checks the committed justification digest against the text the requester sent', async () => {
  const dias = await import('../js/shared/dias.js');
  const { hashText } = await import('../js/shared/commitments.js');
  const text = 'Reviewing the FIR for the open investigation.';
  const committed = { justificationHash: hashText('justification', text) };
  assert.deepEqual(dias.justificationCommitmentView(text, committed), {
    status: 'match', committed: committed.justificationHash, computed: committed.justificationHash,
  });
  const altered = dias.justificationCommitmentView(`${text} `, committed);
  assert.equal(altered.status, 'mismatch');
  assert.equal(dias.justificationCommitmentView(text, {}).status, 'absent');
});

function committedReview(overrides = {}) {
  const recommendationObject = {
    schemaVersion: 'dias-recommendation-object-v1', requestId: 'REQ-1', generationStatus: 'OK',
    recommendation: 'DENY', output: { recommendation: 'DENY', reason: 'Not assigned.' }, error: null,
    provenance: {
      contextHash: '1'.repeat(64), claimsHash: '2'.repeat(64), justificationHash: '3'.repeat(64),
      policyVersion: 'dias-governance-policy-v1', policyHash: '4'.repeat(64), modelVersion: 'base@rev',
    },
  };
  return { recommendationObject, recommendationState: 'committed', ...overrides };
}

test('verifies the displayed recommendation against its ledger commitment in the browser', async () => {
  const dias = await import('../js/shared/dias.js');
  const { hashCanonical } = await import('../js/shared/commitments.js');
  const review = committedReview();
  const object = review.recommendationObject;
  review.commitment = {
    requestId: 'REQ-1', recommendation: 'DENY', generationStatus: 'OK',
    recommendationHash: hashCanonical('recommendation', object), ...object.provenance,
  };
  assert.equal(dias.recommendationIntegrity(review).status, 'verified');

  const edited = { ...review, recommendationObject: { ...object, output: { ...object.output, reason: 'edited' } } };
  const mismatch = dias.recommendationIntegrity(edited);
  assert.equal(mismatch.status, 'mismatch');
  assert.deepEqual(mismatch.problems, ['h_M of the displayed object differs from the committed recommendationHash']);
  assert.equal(dias.recommendationIntegrity({ ...review, recommendationObject: null }).status, 'missing-object');
  assert.equal(dias.recommendationIntegrity({ ...review, commitment: null }).status, 'no-commitment');
});

test('blocks a decision on a mismatch, a missing object, or a commitment not yet on the ledger', async () => {
  const dias = await import('../js/shared/dias.js');
  const { hashCanonical } = await import('../js/shared/commitments.js');
  const base = committedReview({ request: { requester: { username: 'insp.test' } } });
  base.commitment = {
    requestId: 'REQ-1', recommendation: 'DENY', generationStatus: 'OK',
    recommendationHash: hashCanonical('recommendation', base.recommendationObject), ...base.recommendationObject.provenance,
  };
  assert.equal(dias.decisionAvailability(base, 'sp.north').allowed, true);
  const edited = { ...base, recommendationObject: { ...base.recommendationObject, recommendation: 'ALLOW' } };
  assert.deepEqual(
    [dias.decisionAvailability(edited, 'sp.north').allowed, dias.decisionAvailability(edited, 'sp.north').reason],
    [false, 'integrity-mismatch'],
  );
  assert.equal(dias.decisionAvailability({ ...base, recommendationObject: null }, 'sp.north').reason, 'integrity-mismatch');
  assert.equal(dias.decisionAvailability({ ...base, recommendationState: 'signed', commitment: null }, 'sp.north').reason,
    'recommendation-pending');
});

test('derives the consequences of a decision from the committed recommendation', async () => {
  const dias = await import('../js/shared/dias.js');
  const review = { commitment: { recommendation: 'DENY', generationStatus: 'OK' }, recommendation: { generationStatus: 'OK', recommendation: 'ALLOW' } };
  const committed = dias.committedRecommendation(review);
  assert.equal(committed.recommendation, 'DENY');
  assert.equal(dias.willCreateAuthorization(committed, 'FORCE_ALLOW'), true);
  const failed = dias.committedRecommendation({ commitment: { recommendation: null, generationStatus: 'CONTEXT_OVERFLOW' } });
  assert.equal(dias.llmAgreement(failed, 'FORCE_ALLOW'), 'NO_RECOMMENDATION');
  assert.equal(dias.committedRecommendation({ commitment: null, recommendation: null }), null);
});

test('tells an unconfirmed decision apart from a refused or an already-made one', () => {
  const unconfirmed = decisionFailureView({ status: 503, message: 'this decision is not confirmed: the ledger did not answer in time.' });
  assert.equal(unconfirmed.tone, 'warn');
  assert.match(unconfirmed.title, /not confirmed/);
  assert.match(unconfirmed.lines.join(' '), /note is saved/);
  assert.doesNotMatch(unconfirmed.lines.join(' '), /Nothing was recorded/);

  const noResponse = decisionFailureView({ message: 'cannot reach the server — is the backend running?' });
  assert.equal(noResponse.tone, 'warn');
  assert.match(noResponse.lines.join(' '), /may not have received it/);
  assert.doesNotMatch(noResponse.lines.join(' '), /Nothing was recorded/);

  const decided = decisionFailureView({ status: 409, message: 'this request was already decided: FORCE_ALLOW in transaction tx-1' });
  assert.equal(decided.tone, 'info');
  assert.match(decided.title, /already decided/);

  const refused = decisionFailureView({ status: 403, message: 'DIAS_AUDITOR_OUT_OF_DISTRICT: not your district' });
  assert.equal(refused.tone, 'bad');
  assert.match(refused.lines.join(' '), /Nothing was recorded/);
  const mismatch = decisionFailureView({ status: 409, message: 'the stored recommendation does not match its ledger commitment' });
  assert.equal(mismatch.tone, 'bad');
});

test('lists each off-chain object with its check against the ledger digest', () => {
  const rows = offChainVerificationRows({
    justification: { status: 'verified' },
    recommendation: { status: 'mismatch', problems: ['h_M of the stored object differs'] },
    note: { status: 'missing' },
  });
  assert.deepEqual(rows.map((row) => [row.object, row.status]), [
    ['Justification (h_J)', 'verified'], ['Recommendation object (h_M)', 'mismatch'], ['Auditor note (h_N)', 'missing'],
  ]);
  assert.match(rows[1].label, /changed after/);
  assert.match(rows[1].detail, /h_M/);
  assert.match(rows[2].label, /missing/);
  assert.deepEqual(offChainVerificationRows(null), []);
  assert.match(offChainVerificationRows({ note: { status: 'not-committed' } })[0].label, /no digest/);
});

// ---------------------------------------------------------------------------
// Step 13: what the officer who made a request is shown about its decision, and
// the decision log for a caller who only receives the reduced entries.
// ---------------------------------------------------------------------------

const { requesterDecisionView, decisionLogRow } = await import('../js/shared/dias.js');

const decisionBlock = (overrides = {}) => ({
  decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED',
  auditor: { username: 'sp.north', role: 'sp' }, decidedAtUtc: '2026-10-08T09:00:00.000Z', ...overrides,
});

test('shows a denied requester the auditor decision and the LLM explanation', () => {
  const view = requesterDecisionView({
    decision: decisionBlock(), explanationVisible: true, available: true,
    reason: 'The officer is not assigned to the case.', reasonCode: 'NOT_ASSIGNED',
    policyRefs: ['GP-ASSIGN:C1@v1'], missingEvidence: ['case assignment'], reviewFlags: [],
  });
  assert.equal(view.decided, true);
  assert.deepEqual(view.rows, [
    ['Auditor decision', 'FORCE DENY by sp.north'],
    ['LLM recommendation', 'DENY'],
    ['Decision against the LLM', 'agreed with the LLM'],
  ]);
  assert.deepEqual(view.explanation, {
    available: true, reason: 'The officer is not assigned to the case.', reasonCode: 'NOT_ASSIGNED',
    policyRefs: ['GP-ASSIGN:C1@v1'], missingEvidence: ['case assignment'], reviewFlags: [],
  });
});

test('tells a denied requester when there was no LLM recommendation to explain', () => {
  const view = requesterDecisionView({
    decision: decisionBlock({ llmRecommendation: 'UNAVAILABLE', llmAgreement: 'NO_RECOMMENDATION' }),
    explanationVisible: true, available: false, unavailable: { generationStatus: 'UNAVAILABLE', errorCode: 'timeout' },
  });
  assert.deepEqual(view.rows[1], ['LLM recommendation', 'No recommendation was available']);
  assert.deepEqual(view.explanation, { available: false, cause: 'no-recommendation' });
});

test('tells a denied requester when the explanation of a real recommendation is no longer stored', () => {
  const view = requesterDecisionView({
    decision: decisionBlock(), explanationVisible: true, available: false,
    unavailable: { generationStatus: 'NOT_GENERATED', errorCode: 'no_review_stored' },
  });
  // The ledger says the LLM recommended DENY; only its explanation is missing.
  assert.deepEqual(view.rows[1], ['LLM recommendation', 'DENY']);
  assert.deepEqual(view.explanation, { available: false, cause: 'explanation-missing' });
});

test('shows an allowed requester the decision and the recommendation, without an explanation', () => {
  const view = requesterDecisionView({
    decision: decisionBlock({ decision: 'FORCE_ALLOW', llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED' }),
    explanationVisible: false, withheld: 'allowed', recommendation: 'DENY', reason: null,
  });
  assert.deepEqual(view.rows, [
    ['Auditor decision', 'FORCE ALLOW by sp.north'],
    ['LLM recommendation', 'DENY'],
    ['Decision against the LLM', 'did not agree with the LLM'],
  ]);
  assert.equal(view.explanation, null);
});

test('shows a requester nothing from the LLM before a decision or without one', () => {
  for (const detail of [null, undefined, { decision: null, withheld: 'awaiting-decision' }, { decision: null, withheld: 'no-auditor-decision' }]) {
    assert.deepEqual(requesterDecisionView(detail), { decided: false, rows: [], explanation: null });
  }
});

test('lays out a reduced decision-log entry without the identifiers it does not carry', () => {
  const reduced = decisionLogRow({
    redacted: true, outcome: 'DENIED', basis: 'AUDITOR_DECISION', decision: 'FORCE_DENY',
    llmRecommendation: 'DENY', llmAgreement: 'AGREED', generationStatus: 'OK', action: 'view',
    purpose: 'investigation', requester: { organization: 'police' }, decidedAtUtc: '2026-10-08T09:00:00.000Z',
  });
  assert.deepEqual(reduced, {
    redacted: true, when: '2026-10-08T09:00:00.000Z', requester: null, organization: 'police', recordId: null,
    caseId: null, operation: 'view · investigation', outcome: 'DENIED', decidedBy: 'an auditor',
    decision: 'FORCE_DENY', llmRecommendation: 'DENY', llmAgreement: 'AGREED', requestId: null, transaction: null,
  });
  const full = decisionLogRow({
    requestId: 'REQ-1', recordId: 'REC-1', caseId: 'CASE-1', action: 'view', purpose: 'investigation',
    requester: { username: 'insp.sharma', organization: 'police', role: 'inspector' }, outcome: 'GRANTED',
    basis: 'DYNAMIC_AUTHORIZATION', auditor: null, decision: null, llmRecommendation: null, llmAgreement: null,
    authorizationId: 'AUTH-1', decidedAtUtc: '2026-10-08T10:00:00.000Z', outcomeTxId: 'tx-9', decisionTxId: null,
  });
  assert.equal(full.redacted, false);
  assert.equal(full.requester, 'insp.sharma');
  assert.equal(full.decidedBy, 'dynamic authorization AUTH-1');
  assert.equal(full.transaction, 'tx-9');
  assert.equal(decisionLogRow({ redacted: true, basis: 'DYNAMIC_AUTHORIZATION', requester: {} }).decidedBy,
    'a dynamic authorization');
});
