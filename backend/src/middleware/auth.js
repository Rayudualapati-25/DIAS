'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

/** Verify the bearer token and attach { username, org, fabricUser, role }. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, data: null, error: 'missing bearer token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, data: null, error: 'invalid or expired token' });
  }
}

/** Restrict a route to callers whose department role is in the list. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        data: null,
        error: `requires role in [${roles.join(', ')}]`,
      });
    }
    return next();
  };
}

module.exports = { requireAuth, requireRole };
