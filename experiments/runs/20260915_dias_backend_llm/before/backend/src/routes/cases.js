'use strict';

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const createSchema = z.object({
  caseId: z.string().regex(SAFE_ID),
  jurisdiction: z.string().regex(SAFE_ID),
  status: z.enum(['open', 'under-investigation', 'filed-to-court', 'closed']).optional(),
  assignedUsers: z.array(z.string().regex(SAFE_ID)).default([]),
  protectedClassifications: z.array(
    z.enum(['juvenile', 'witness', 'victim', 'sealed'])
  ).default([]),
});

router.get('/', asyncRoute(async (req, res) => {
  const items = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'QueryCases');
  return ok(res, items);
}));

router.get('/:caseId', asyncRoute(async (req, res) => {
  const item = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'ReadCase', req.params.caseId);
  return ok(res, item);
}));

router.post('/', requireRole('sub-inspector', 'inspector', 'circle-inspector', 'investigating-officer'),
  asyncRoute(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const { caseId, ...input } = parsed.data;
    const item = await fabric.submit(
      req.user.org, req.user.fabricUser, 'GovernanceContract', 'CreateCase',
      caseId, JSON.stringify({ ...input, owningAgency: req.user.org }));
    return ok(res, item, 201);
  }));

const assignmentSchema = z.object({ userId: z.string().regex(SAFE_ID) });
router.post('/:caseId/assign', requireRole('circle-inspector', 'inspector'), asyncRoute(async (req, res) => {
  const parsed = assignmentSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const item = await fabric.submit(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'AssignCaseUser',
    req.params.caseId, parsed.data.userId);
  return ok(res, item);
}));

const workflowSchema = z.object({
  nextStatus: z.enum(['filed-to-court', 'closed']),
  reference: z.string().regex(SAFE_ID),
  note: z.string().max(500).optional(),
});
router.post('/:caseId/workflow',
  requireRole('circle-inspector', 'public-prosecutor', 'judge', 'magistrate'),
  asyncRoute(async (req, res) => {
    const parsed = workflowSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const item = await fabric.submit(
      req.user.org, req.user.fabricUser, 'GovernanceContract', 'AdvanceCaseWorkflow',
      req.params.caseId, parsed.data.nextStatus, parsed.data.reference,
      parsed.data.note || '');
    return ok(res, item);
  }));

router.get('/:caseId/workflow', asyncRoute(async (req, res) => {
  const items = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'QueryCaseWorkflow',
    req.params.caseId);
  return ok(res, items);
}));

module.exports = router;
