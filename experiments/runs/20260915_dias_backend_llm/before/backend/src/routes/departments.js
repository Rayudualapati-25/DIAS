'use strict';

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const schema = z.object({
  departmentId: z.enum(['police', 'forensics', 'prosecution', 'court', 'audit']),
  name: z.string().min(1).max(120),
  type: z.enum(['police', 'forensics', 'prosecution', 'court', 'oversight']),
  jurisdiction: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  permittedFunctions: z.array(z.string().min(1).max(64)).min(1),
});

router.get('/', asyncRoute(async (req, res) => {
  const items = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'QueryDepartments');
  return ok(res, items);
}));

router.post('/', asyncRoute(async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const { departmentId, ...profile } = parsed.data;
  const created = await fabric.submit(
    req.user.org, req.user.fabricUser, 'GovernanceContract', 'CreateDepartment',
    departmentId, JSON.stringify({ ...profile, status: 'active' }));
  return ok(res, created, 201);
}));

module.exports = router;
