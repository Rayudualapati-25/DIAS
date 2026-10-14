'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

const PAGE_KIND = 'mobile-case-page';

function pageError(message, status) {
  return Object.assign(new Error(message), { status });
}

function validateQuery(query) {
  const value = query.limit === undefined ? '20' : query.limit;
  if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value) || Number(value) > 50) {
    throw pageError('limit must be an integer from 1 to 50', 400);
  }
  if (query.cursor !== undefined && (typeof query.cursor !== 'string'
      || query.cursor.length === 0 || query.cursor.length > 2048)) {
    throw pageError('invalid page cursor', 400);
  }
  return { limit: Number(value), cursor: query.cursor };
}

function casePage({ items, user, limit, cursor, secret = JWT_SECRET }) {
  // A continuation must not also be accepted as a login bearer token.
  const cursorSecret = crypto.createHmac('sha256', secret).update(PAGE_KIND).digest('hex');
  const summaries = items.map((item) => ({
    caseId: item.caseId,
    owningAgency: item.owningAgency,
    jurisdiction: item.jurisdiction,
    status: item.status,
  })).sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const snapshot = crypto.createHash('sha256').update(JSON.stringify(summaries)).digest('hex');
  const principal = `${user.org}:${user.username}`;
  let after = null;
  if (cursor) {
    let claims;
    try {
      claims = jwt.verify(cursor, cursorSecret, { algorithms: ['HS256'] });
    } catch {
      throw pageError('invalid or expired page cursor; refresh from the first batch', 400);
    }
    if (claims.kind !== PAGE_KIND || claims.principal !== principal
        || typeof claims.after !== 'string') {
      throw pageError('page cursor does not belong to this account', 400);
    }
    if (claims.snapshot !== snapshot) {
      throw pageError('case list changed; refresh from the first batch', 409);
    }
    after = claims.after;
  }
  const remaining = after === null ? summaries : summaries.filter((item) => item.caseId > after);
  const page = remaining.slice(0, limit);
  const nextCursor = remaining.length > limit ? jwt.sign({
    kind: PAGE_KIND, principal, snapshot, after: page[page.length - 1].caseId,
  }, cursorSecret, { algorithm: 'HS256', expiresIn: '15m' }) : null;
  return { items: page, nextCursor, total: summaries.length, snapshot };
}

module.exports = { casePage, validateQuery };
