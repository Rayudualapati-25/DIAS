'use strict';

/**
 * DIAS access API.
 *
 * The workflow this exposes:
 *   1. a requester submits a request under their own Fabric identity; the
 *      chaincode commits who asked for which record and checks the latest active
 *      dynamic authorization in the same transaction — an exact match grants at
 *      once, with the auditor recorded as skipped;
 *   2. otherwise this backend asks the LLM for an advisory ALLOW/DENY
 *      recommendation and keeps it off-chain for the auditor screen;
 *   3. an auditor issues FORCE_ALLOW or FORCE_DENY, which is the final word. The
 *      backend commits the decision together with whether it agreed with the LLM.
 *
 * A recommendation is never returned as a decision, and it is never written to
 * the ledger. The only 201 "decided" response comes from an access outcome
 * committed on Fabric.
 */

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDiasRuntime } = require('../dias/runtime');
const { RECOMMENDATION_STATE } = require('../dias/reviewStore');
const {
  createsAuthorization, llmAgreementFor, requiresAuditorReason,
} = require('../dias/agreement');
const { ACTIONS, PURPOSES, DISTRICT_HEAD_ROLES } =
  require('../../../chaincode/crimerecords/lib/policy/policyV1');

const router = express.Router();
router.use(requireAuth);

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CONTRACT = 'AccessContract';

/**
 * Auditors are district heads of the audit organisation. The chaincode is the
 * real boundary and enforces both organisation and role; mirroring the role list
 * here refuses an unauthorised caller early with 403 rather than late with a
 * chaincode error.
 */
const AUDITOR_ROLES = [...DISTRICT_HEAD_ROLES];

const ENDORSEMENT_CONVERGENCE_RETRIES = Number(process.env.ENDORSEMENT_CONVERGENCE_RETRIES || 5);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isEndorsementConvergenceError(error) {
  return /ProposalResponsePayloads do not match/i.test(error?.message || '');
}

/**
 * A commit is observed first by the submitter's peer, so for a brief interval
 * the endorsing peers can simulate different dynamic-authorization states. That
 * specific failure happens before submission, so a new proposal is safe; no
 * other Fabric failure is retried here.
 */
async function submitAccessRequest(user, args, {
  ledger = fabric,
  sleep = delay,
  retries = ENDORSEMENT_CONVERGENCE_RETRIES,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ledger.submit(user.org, user.fabricUser, CONTRACT, 'CreateAccessRequest', ...args);
    } catch (error) {
      if (!isEndorsementConvergenceError(error) || attempt >= retries) throw error;
      await sleep(150 * (2 ** attempt));
    }
  }
}

/**
 * The auditor-facing view of one committed request: the ledger request plus
 * what the backend holds off-chain — the requester's justification and the LLM
 * recommendation, or the fact that it is still being prepared or was never made.
 */
function reviewView(request, entry) {
  return {
    request,
    justification: entry ? entry.justification : null,
    recommendationState: entry ? entry.recommendationState : 'not-generated',
    recommendation: entry ? entry.recommendation : null,
    auditorNote: entry ? entry.auditorNote : null,
  };
}

/**
 * Keep the off-chain review for a request that waits for the auditor, and queue
 * its LLM recommendation. The request is already committed, so a failure to save
 * the review must not turn into an error for the requester: the auditor then
 * decides without a recommendation, which the ledger records as such.
 */
function openReview({ request, justification, store, worker, log = console }) {
  try {
    store.create({ request, justification });
  } catch (error) {
    log.error(`[dias] ${request.requestId} off-chain review could not be saved: ${error.message}`);
    return {
      recommendationState: 'not-generated',
      message: 'The request is on the ledger, but its off-chain review could not be saved. '
        + 'An auditor will make the final decision without an LLM recommendation.',
    };
  }
  worker.enqueue(request.requestId);
  return {
    recommendationState: 'pending',
    message: 'The request is on the ledger. An auditor will make the final decision.',
  };
}

/**
 * `action` and `purpose` are canonical request facts: the chaincode validates
 * them against the policy vocabulary and commits them with the request.
 * `justification` is the requester's own free text; it stays in this backend,
 * goes to the LLM, and is shown to the auditor, but it is never written to the
 * ledger.
 */
const requestSchema = z.object({
  recordId: z.string().regex(SAFE_ID),
  action: z.enum(ACTIONS),
  purpose: z.enum(PURPOSES),
  justification: z.string().min(3).max(2000),
  emergencyFlag: z.boolean().optional(),
});

router.post('/request', asyncRoute(async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const { recordId, justification, action, purpose, emergencyFlag } = parsed.data;

  const request = await submitAccessRequest(req.user, [
    recordId, JSON.stringify({ action, purpose, emergencyFlag: emergencyFlag === true }),
  ]);

  // The application access event is submitted after the HTTP response. Pass
  // the Fabric-generated identifier to that logger so an auditor can correlate
  // the API action with this exact on-chain request.
  res.locals.accessEventTarget = {
    requestId: request.requestId,
    processingPath: request.processingPath,
  };

  if (request.processingPath === 'dynamic-authorization') {
    return ok(res, {
      ...request,
      processingState: 'decided',
      automatic: true,
      message: 'An active dynamic authorization matched this exact request. '
        + 'Access was granted automatically, without auditor review.',
    }, 201);
  }

  const { store, worker } = getDiasRuntime();
  const review = openReview({ request, justification, store, worker });
  return ok(res, {
    ...request,
    processingState: 'awaiting-auditor',
    automatic: false,
    recommendationState: review.recommendationState,
    message: review.message,
  }, 202);
}));

/** One access request, so a requester can see that it was raised and answered. */
router.get('/request/:requestId', asyncRoute(async (req, res) => {
  const request = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'GetRequest', req.params.requestId);
  return ok(res, request);
}));

/** The full Fabric-reconstructed lifecycle of one request. */
router.get('/request/:requestId/trail', asyncRoute(async (req, res) => {
  const trail = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AuditContract', 'GetRequestAuditTrail',
    req.params.requestId);
  return ok(res, trail);
}));

/**
 * The public decision log: every settled request with what was decided for it.
 * Readable by any signed-in identity, because the point of the shared ledger is
 * that a decision cannot be made invisibly. It carries no justification and
 * nothing the LLM produced.
 */
router.get('/decision-log', asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  const entries = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'QueryAccessDecisions', String(limit));
  return ok(res, { entries, storage: 'fabric-ledger' });
}));

router.get('/record/:recordId', asyncRoute(async (req, res) => {
  const decisions = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'QueryDecisionsByRecord', req.params.recordId);
  return ok(res, decisions);
}));

router.get('/decision/:recordId/:decisionId', asyncRoute(async (req, res) => {
  const decision = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'GetDecision',
    req.params.recordId, req.params.decisionId);
  return ok(res, decision);
}));

// --- Auditor -------------------------------------------------------------

/** Everything awaiting a final decision, each with its off-chain recommendation. */
router.get('/auditor/pending', requireRole(...AUDITOR_ROLES), asyncRoute(async (req, res) => {
  const pending = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'QueryPendingAuditorRequests');
  const { store } = getDiasRuntime();
  return ok(res, pending.map(({ request }) => reviewView(request, store.read(request.requestId))));
}));

router.get('/auditor/:requestId', requireRole(...AUDITOR_ROLES), asyncRoute(async (req, res) => {
  const { request } = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'GetAuditorReview', req.params.requestId);
  const { store } = getDiasRuntime();
  return ok(res, reviewView(request, store.read(request.requestId)));
}));

/**
 * The final decision. The backend, not the browser, works out whether it agreed
 * with the stored LLM recommendation, and commits that with the decision. A
 * reason is required whenever the auditor did not simply agree with the LLM; it
 * is kept off-chain with the review. `validUntilUtc` is accepted only where a
 * dynamic authorization is created: FORCE_ALLOW that did not agree with an LLM
 * DENY.
 */
const auditorDecisionSchema = z.object({
  decision: z.enum(['FORCE_ALLOW', 'FORCE_DENY']),
  reason: z.string().max(500).optional(),
  validUntilUtc: z.string().datetime().optional(),
});

async function decide({ user, requestId, body, ledger = fabric, store }) {
  const parsed = auditorDecisionSchema.safeParse(body || {});
  if (!parsed.success) return { status: 400, error: parsed.error.issues[0].message };
  const { decision, validUntilUtc } = parsed.data;
  const reason = (parsed.data.reason || '').trim();
  const entry = store.read(requestId);
  if (entry && entry.recommendationState === RECOMMENDATION_STATE.PENDING) {
    return {
      status: 409,
      error: 'the LLM recommendation for this request is still being prepared; try again shortly',
    };
  }
  const llmAgreement = llmAgreementFor(entry ? entry.recommendation : null, decision);
  if (requiresAuditorReason(llmAgreement) && reason.length === 0) {
    return {
      status: 400,
      error: 'a reason is required when the decision does not agree with the LLM recommendation or no recommendation exists',
    };
  }
  if (validUntilUtc && !createsAuthorization(decision, llmAgreement)) {
    return { status: 400, error: 'validUntilUtc applies only when a dynamic authorization is created' };
  }
  const result = await ledger.submit(
    user.org, user.fabricUser, CONTRACT, 'SubmitAuditorDecision',
    requestId, decision, llmAgreement, validUntilUtc || ''
  );
  if (entry) {
    store.update(requestId, {
      auditorNote: {
        decision,
        llmAgreement,
        reason: reason || null,
        auditorUsername: user.username || user.fabricUser,
        decidedAtUtc: result.auditorDecision.decidedAtUtc,
        txId: result.auditorDecision.txId,
      },
    });
  }
  return { status: 201, data: result, llmAgreement };
}

router.post('/auditor/:requestId/decision', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    if (!SAFE_ID.test(req.params.requestId || '')) return fail(res, 'requestId has invalid format');
    const outcome = await decide({
      user: req.user, requestId: req.params.requestId, body: req.body, store: getDiasRuntime().store,
    });
    if (outcome.error) return fail(res, outcome.error, outcome.status);
    res.locals.accessEventTarget = { llmAgreement: outcome.llmAgreement };
    return ok(res, outcome.data, outcome.status);
  }));

// --- Dynamic authorizations ----------------------------------------------

router.get('/dynamic-authorizations', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    const status = String(req.query.status || 'active');
    const authorizations = await fabric.evaluate(
      req.user.org, req.user.fabricUser, CONTRACT, 'QueryDynamicAuthorizations', status);
    return ok(res, authorizations);
  }));

router.get('/dynamic-authorizations/:authorizationId', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    const authorization = await fabric.evaluate(
      req.user.org, req.user.fabricUser, CONTRACT, 'GetDynamicAuthorization',
      req.params.authorizationId);
    return ok(res, authorization);
  }));

router.get('/dynamic-authorizations/:authorizationId/history', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    const history = await fabric.evaluate(
      req.user.org, req.user.fabricUser, CONTRACT, 'GetDynamicAuthorizationHistory',
      req.params.authorizationId);
    return ok(res, history);
  }));

/**
 * Revocation is explicit and always carries a reason. FORCE_DENY on a later
 * request never revokes anything implicitly, so this is the only way an active
 * authorization stops matching before it expires.
 */
const revokeSchema = z.object({ reason: z.string().min(1).max(500) });

router.post('/dynamic-authorizations/:authorizationId/revoke', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    const parsed = revokeSchema.safeParse(req.body || {});
    if (!parsed.success) return fail(res, 'a revocation reason is required');
    const revoked = await fabric.submit(
      req.user.org, req.user.fabricUser, CONTRACT, 'RevokeDynamicAuthorization',
      req.params.authorizationId, parsed.data.reason);
    return ok(res, revoked);
  }));

module.exports = router;
module.exports.AUDITOR_ROLES = AUDITOR_ROLES;
module.exports.requestSchema = requestSchema;
module.exports.decide = decide;
module.exports.openReview = openReview;
module.exports.reviewView = reviewView;
module.exports.submitAccessRequest = submitAccessRequest;
module.exports.isEndorsementConvergenceError = isEndorsementConvergenceError;
