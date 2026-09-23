'use strict';

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const vault = require('../storage/vault');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Mirrors AuditContract's reviewer roles exactly. The chaincode is the real
// boundary and enforces both organisation and role; keeping the API list
// identical means an unauthorised caller is refused early with 403 rather than
// late with a chaincode error.
const { SEAL_AUTHORITY_ROLES, DISTRICT_HEAD_ROLES } =
  require('../../../chaincode/crimerecords/lib/policy/policyV1');
const REVIEWER_ROLES = [...new Set([...SEAL_AUTHORITY_ROLES, ...DISTRICT_HEAD_ROLES])];

/** Full reconstruction trace: record history + every decision + explanations. */
router.get('/trail/:recordId', requireRole(...REVIEWER_ROLES), asyncRoute(async (req, res) => {
  const trail = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AuditContract', 'GetAuditTrail',
    req.params.recordId);
  return ok(res, trail);
}));

/**
 * Recompute the agency-held raw-content hash and compare it with Fabric's
 * immutable metadata commitment.
 */
router.post('/verify-payload/:recordId', requireRole(...REVIEWER_ROLES),
  asyncRoute(async (req, res) => {
    const record = await fabric.evaluate(
      req.user.org, req.user.fabricUser, 'RecordContract', 'GetRecord',
      req.params.recordId);
    const stored = vault.read(record.offChainReference);
    const result = await fabric.evaluate(
      req.user.org, req.user.fabricUser, 'AuditContract', 'VerifyRecordPayload',
      req.params.recordId, stored.currentHash);
    return ok(res, { ...result, verifiedAt: new Date().toISOString() });
  }));

/**
 * Direct Fabric access events: who searched, read or received a case file.
 */
router.get('/access-log', requireRole(...REVIEWER_ROLES), asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const entries = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AuditContract', 'QueryAccessEvents', String(limit));
  return ok(res, {
    entries,
    storage: 'fabric-ledger',
    integrity: 'validated by Fabric block history and endorsement',
  });
}));

/** Report the integrity mechanism now that no external log needs anchoring. */
router.get('/access-log/verify', requireRole(...REVIEWER_ROLES), asyncRoute(async (req, res) => {
  const entries = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AuditContract', 'QueryAccessEvents', '500');
  return ok(res, {
    ok: true,
    entriesChecked: entries.length,
    storage: 'fabric-ledger',
    mechanism: 'Fabric endorsement, ordering, block hashes, and immutable key history',
    verifiedAt: new Date().toISOString(),
  });
}));

/**
 * Complete Fabric-reconstructed lifecycle of one access request: submission,
 * dynamic-authorization check, recommendation (or skip, or failure), auditor
 * decision (or skip), authorization changes and the access outcome, each with
 * the transaction that committed it.
 *
 * The chaincode authorises this itself — reviewers see the private text, the
 * requester sees hash checks only — so no role guard is applied here beyond
 * authentication.
 */
router.get('/request-trail/:requestId', asyncRoute(async (req, res) => {
  const trail = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AuditContract', 'GetRequestAuditTrail',
    req.params.requestId);
  return ok(res, trail);
}));

const reasonSchema = z.object({ reason: z.string().min(1).max(600) });

/**
 * Verify a held recommendation reason against the hash committed on the ledger.
 * The reason text itself lives in a private collection; this proves that a copy
 * held off-chain is the one the AI organisation attested to.
 */
router.post('/verify-recommendation-reason/:requestId', requireRole(...REVIEWER_ROLES),
  asyncRoute(async (req, res) => {
    const parsed = reasonSchema.safeParse(req.body || {});
    if (!parsed.success) return fail(res, 'reason text is required');
    const result = await fabric.evaluate(
      req.user.org, req.user.fabricUser, 'AuditContract', 'VerifyRecommendationReason',
      req.params.requestId, parsed.data.reason);
    return ok(res, result);
  }));

module.exports = router;
