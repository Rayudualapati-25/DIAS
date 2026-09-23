'use strict';

/**
 * DIAS access API.
 *
 * The workflow this exposes:
 *   1. a requester submits a request under their own Fabric identity;
 *   2. the chaincode commits it and checks the latest active dynamic
 *      authorization in the same transaction — an exact match grants at once,
 *      with the LLM and the auditor recorded as skipped;
 *   3. otherwise the AI organisation records an advisory ALLOW/DENY
 *      recommendation (or a generation-failure status) and the request enters
 *      the auditor queue;
 *   4. an auditor issues FORCE_ALLOW or FORCE_DENY, which is the final word.
 *
 * A recommendation is never returned as a decision. The only 201 "decided"
 * response this API produces comes from an access outcome committed on Fabric.
 */

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth, requireRole } = require('../middleware/auth');
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

/**
 * The browser must not give up before the model can. The default waits for the
 * inference budget plus headroom for endorsement and commit; waiting less
 * produced a "not answered yet" response for requests the AI organisation went
 * on to answer and commit.
 */
const MODEL_TIMEOUT_MS = Number(process.env.DIAS_MODEL_TIMEOUT_MS || 120000);
const COMMIT_HEADROOM_MS = 30000;
const PROGRESS_TIMEOUT_MS = Number(
  process.env.DIAS_PROGRESS_TIMEOUT_MS || MODEL_TIMEOUT_MS + COMMIT_HEADROOM_MS
);
const PROGRESS_POLL_MS = 250;
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
async function submitAccessRequest(user, args, transientData, {
  ledger = fabric,
  sleep = delay,
  retries = ENDORSEMENT_CONVERGENCE_RETRIES,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await ledger.submitWithTransient(
        user.org, user.fabricUser, CONTRACT, 'CreateAccessRequest',
        args, transientData, ledger.ACCESS_QUERY_ENDORSERS
      );
    } catch (error) {
      if (!isEndorsementConvergenceError(error) || attempt >= retries) throw error;
      await sleep(150 * (2 ** attempt));
    }
  }
}

/**
 * Wait until a request either has a committed outcome or is waiting for the
 * auditor. A dynamic-authorization hit is already final on return from
 * CreateAccessRequest; a miss reaches 'awaiting-auditor' once the AI
 * organisation has recorded its recommendation or its failure status.
 */
async function waitForAccessProgress(user, request, timeoutMs, {
  ledger = fabric,
  sleep = delay,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const stored = await ledger.evaluate(
      user.org, user.fabricUser, CONTRACT, 'GetRequest', request.requestId);
    if (stored.status === 'granted' || stored.status === 'denied') {
      return { state: 'decided', data: stored };
    }
    if (stored.status === 'awaiting-auditor') {
      return { state: 'awaiting-auditor', data: stored };
    }
    if (Date.now() >= deadline) return { state: 'awaiting-recommendation', data: stored };
    await sleep(PROGRESS_POLL_MS);
  }
}

/**
 * `action` and `purpose` are canonical request facts: the chaincode validates
 * them against the policy vocabulary and commits them inside the verified
 * request before any inference. `justification` is the requester's own free
 * text; it travels as transient data into a private collection and is untrusted
 * throughout.
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

  // The requester raises the request under their OWN identity, and the
  // justification travels transiently into a collection the AI organisation is
  // a member of, so the model reads it from the ledger, not from this server.
  const request = await submitAccessRequest(
    req.user,
    [recordId, JSON.stringify({ action, purpose, emergencyFlag: emergencyFlag === true })],
    { justification: Buffer.from(justification, 'utf8') }
  );

  // The application access event is submitted after the HTTP response. Pass
  // the Fabric-generated identifier to that logger so an auditor can correlate
  // the API action with this exact on-chain request lifecycle.
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
        + 'Access was granted automatically; the model and the auditor were skipped.',
    }, 201);
  }

  const progress = await waitForAccessProgress(req.user, request, PROGRESS_TIMEOUT_MS);
  const messages = {
    decided: 'An auditor has already decided this request.',
    'awaiting-auditor': 'A recommendation was recorded. An auditor must make the final decision.',
    'awaiting-recommendation': 'The request is on the ledger and is waiting for the policy model.',
  };
  return ok(res, {
    ...progress.data,
    processingState: progress.state,
    automatic: false,
    message: messages[progress.state],
  }, progress.state === 'decided' ? 201 : 202);
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

/** Everything awaiting a final decision, each with its recommendation. */
router.get('/auditor/pending', requireRole(...AUDITOR_ROLES), asyncRoute(async (req, res) => {
  const pending = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'QueryPendingAuditorRequests');
  return ok(res, pending);
}));

router.get('/auditor/:requestId', requireRole(...AUDITOR_ROLES), asyncRoute(async (req, res) => {
  const review = await fabric.evaluate(
    req.user.org, req.user.fabricUser, CONTRACT, 'GetAuditorReview', req.params.requestId);
  return ok(res, review);
}));

/**
 * The final decision. `reason` is mandatory whenever the auditor differs from
 * the recommendation or no recommendation exists; the chaincode enforces that
 * and this route does not second-guess it. `validUntilUtc` is accepted only
 * where a dynamic authorization is actually created (DENY + FORCE_ALLOW).
 */
const auditorDecisionSchema = z.object({
  decision: z.enum(['FORCE_ALLOW', 'FORCE_DENY']),
  reason: z.string().max(500).optional(),
  validUntilUtc: z.string().datetime().optional(),
});

router.post('/auditor/:requestId/decision', requireRole(...AUDITOR_ROLES),
  asyncRoute(async (req, res) => {
    const parsed = auditorDecisionSchema.safeParse(req.body || {});
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const result = await fabric.submit(
      req.user.org, req.user.fabricUser, CONTRACT, 'SubmitAuditorDecision',
      req.params.requestId,
      parsed.data.decision,
      parsed.data.reason || '',
      parsed.data.validUntilUtc || '');
    return ok(res, result, 201);
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
module.exports.waitForAccessProgress = waitForAccessProgress;
module.exports.submitAccessRequest = submitAccessRequest;
module.exports.isEndorsementConvergenceError = isEndorsementConvergenceError;
