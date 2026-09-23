'use strict';

/**
 * Local demonstration sign-in backed by a Fabric identity and ledger profile.
 * No password or password hash is stored. The backend proves it can sign with
 * the selected enrolled identity, then issues the browser a short-lived JWT.
 * Because development private keys are server-held, this is a custodial demo
 * selector—not production proof of an end user's key possession.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const users = require('../fabric/users');
const { JWT_SECRET, JWT_EXPIRY } = require('../config');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
});

router.post('/login', asyncRoute(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 'username is required');

  const { username } = parsed.data;
  const profile = await users.readForLogin(username);

  if (!profile) return fail(res, 'Fabric identity is not registered', 401);

  let user;
  try {
    user = await users.authenticate(profile.org, profile.fabricUser, username);
  } catch (err) {
    const message = String(err.message || err);
    if (message.includes('account is')) {
      return fail(res, message.replace(/^.*unauthorized: /, ''), 403);
    }
    return fail(res, 'Fabric identity could not be verified', 401);
  }

  const claims = {
    username: user.userId,
    org: user.org,
    fabricUser: user.fabricUser,
    role: user.role,
    displayName: user.displayName,
  };
  const token = jwt.sign(claims, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  req.user = claims;
  return ok(res, { token, user: claims });
}));

router.get('/me', requireAuth, (req, res) => ok(res, req.user));

module.exports = router;
