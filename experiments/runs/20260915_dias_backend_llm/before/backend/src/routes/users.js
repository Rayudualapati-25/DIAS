'use strict';

/**
 * User administration — the two-step registration this system is built around.
 *
 *   Step 1 (CA):     the department's Fabric CA issues an X.509 identity, with
 *                    the officer's role, station and clearance signed into the
 *                    certificate. The CA uses its own embedded registry.
 *   Step 2 (LEDGER): a CreateUser transaction writes the account onto the
 *                    blockchain, endorsed and replicated to all five
 *                    departments.
 *
 * Both steps are needed. Step 1 alone gives someone a certificate that no
 * account exists for; step 2 alone gives an account that cannot sign anything.
 *
 * Authorisation is not decided here. The ledger transaction is signed by the
 * logged-in officer, and UserContract rejects it unless they hold an
 * administrative role in the department they are registering into. This route
 * only checks that the request is well formed.
 */

const express = require('express');
const { z } = require('zod');
const users = require('../fabric/users');
const ca = require('../fabric/ca');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth } = require('../middleware/auth');
const { ORG_CONFIG } = require('../config');

const router = express.Router();
router.use(requireAuth);

const ORGS = Object.keys(ORG_CONFIG);
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ATTR_VALUE = /^[A-Za-z0-9._|-]{1,128}$/;

const ROLES = [
  'constable', 'sub-inspector', 'inspector', 'investigating-officer',
  'circle-inspector', 'dsp', 'sp', 'commissioner',
  'lab-assistant', 'lab-analyst', 'senior-analyst', 'lab-director', 'chief-forensic-officer',
  'defense-counsel', 'assistant-public-prosecutor', 'public-prosecutor',
  'senior-public-prosecutor', 'director-of-prosecution',
  'court-clerk', 'magistrate', 'judge', 'district-judge',
];

const registerSchema = z.object({
  username: z.string().regex(SAFE_ID),
  displayName: z.string().min(1).max(120),
  org: z.enum(ORGS),
  role: z.enum(ROLES),
  // Certificate attributes. role is taken from the field above so the account
  // record and the certificate can never disagree about it.
  rank: z.string().regex(ATTR_VALUE).optional(),
  station: z.string().regex(ATTR_VALUE).optional(),
  jurisdiction: z.string().regex(ATTR_VALUE),
  badgeId: z.string().regex(ATTR_VALUE).optional(),
  clearance: z.enum(['low', 'medium', 'high']),
  caseAssignments: z.string().regex(ATTR_VALUE).optional(),
});

const statusSchema = z.object({
  status: z.enum(['active', 'revoked', 'suspended']),
});

/** Everyone on the ledger. Credentials are stripped by the chaincode. */
router.get('/', asyncRoute(async (req, res) => {
  const list = await users.list(req.user.org, req.user.fabricUser);
  return ok(res, list);
}));

/** One account, public view. */
router.get('/:username', asyncRoute(async (req, res) => {
  if (!SAFE_ID.test(req.params.username)) return fail(res, 'invalid username');
  const user = await users.read(req.user.org, req.user.fabricUser, req.params.username);
  return ok(res, user);
}));

/** Admission and status history, straight from the key's ledger history. */
router.get('/:username/history', asyncRoute(async (req, res) => {
  if (!SAFE_ID.test(req.params.username)) return fail(res, 'invalid username');
  const history = await users.history(
    req.user.org, req.user.fabricUser, req.params.username);
  return ok(res, history);
}));

/** Register a new officer: CA identity, then on-chain account. */
router.post('/', asyncRoute(async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const input = parsed.data;

  if (ca.isEnrolled(input.org, input.username)) {
    return fail(res, `identity '${input.username}' is already enrolled in ${input.org}`, 409);
  }

  // Refuse obviously unauthorised registrations before issuing a certificate.
  // The chaincode is still the authority — this only stops the CA handing out
  // a certificate for a transaction that is certain to be rejected, which
  // would strand an identity belonging to no account.
  if (input.org !== req.user.org) {
    return fail(res, 'you can only register officers into your own department', 403);
  }

  // Step 1 — X.509 identity, attributes signed into the certificate.
  await ca.registerAndEnroll({
    org: input.org,
    fabricUser: input.username,
    attributes: {
      role: input.role,
      rank: input.rank,
      station: input.station,
      jurisdiction: input.jurisdiction,
      badgeId: input.badgeId,
      clearance: input.clearance,
      credentialStatus: 'active',
      caseAssignments: input.caseAssignments,
    },
  });

  // Step 2 — the authorization profile, onto the ledger, signed by the
  // admitting officer. No application password or password hash exists.
  let account;
  try {
    account = await users.create(
      req.user.org, req.user.fabricUser, input.username, {
        displayName: input.displayName,
        org: input.org,
        role: input.role,
        fabricUser: input.username,
        departmentId: input.org,
        rank: input.rank,
        station: input.station,
        jurisdiction: input.jurisdiction,
        clearance: input.clearance,
        caseAssignments: input.caseAssignments
          ? input.caseAssignments.split('|').filter(Boolean)
          : [],
        credentialStatus: 'active',
      });
  } catch (err) {
    // The chaincode refused, so there must be no certificate left over for an
    // account that was never created.
    ca.removeEnrollment(input.org, input.username);
    throw err;
  }

  return ok(res, account, 201);
}));

/** Revoke, suspend or reinstate. The account record is never deleted. */
router.post('/:username/status', asyncRoute(async (req, res) => {
  if (!SAFE_ID.test(req.params.username)) return fail(res, 'invalid username');
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);

  const updated = await users.setStatus(
    req.user.org, req.user.fabricUser, req.params.username, parsed.data.status);
  return ok(res, updated);
}));

module.exports = router;
