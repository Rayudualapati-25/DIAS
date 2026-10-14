'use strict';

const { expect } = require('chai');
const express = require('express');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../src/config');
const { casePage, validateQuery } = require('../src/mobile/casePage');
const { createMobileRouter } = require('../src/routes/mobile');

const user = { username: 'mobile.fixture', org: 'police', fabricUser: 'mobile.fixture' };
const items = Array.from({ length: 53 }, (_, index) => ({
  caseId: `CASE-${String(index).padStart(3, '0')}`, owningAgency: 'police',
  jurisdiction: 'North', status: 'open', privateField: 'must not leave host',
})).reverse();

describe('mobile case batches', () => {
  it('covers the baseline exactly in bounded, stable, duplicate-free pages', () => {
    const found = [];
    let cursor;
    do {
      const page = casePage({ items, user, limit: 20, cursor });
      expect(page.items.length).to.be.at.most(20);
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(found.map((item) => item.caseId)).to.deep.equal(items.map((item) => item.caseId).sort());
    expect(new Set(found.map((item) => item.caseId)).size).to.equal(53);
    expect(found[0]).to.have.all.keys('caseId', 'owningAgency', 'jurisdiction', 'status');
  });

  it('handles an empty list and a final exact-sized page', () => {
    expect(casePage({ items: [], user, limit: 20 }).nextCursor).to.equal(null);
    expect(casePage({ items: items.slice(0, 20), user, limit: 20 }).nextCursor).to.equal(null);
  });

  it('rejects forged, expired, login-token and other-account cursors', () => {
    const page = casePage({ items, user, limit: 20 });
    expect(() => jwt.verify(page.nextCursor, JWT_SECRET)).to.throw();
    const expired = jwt.sign({ kind: 'mobile-case-page' }, JWT_SECRET, { expiresIn: -1 });
    for (const cursor of ['forged', expired, jwt.sign(user, JWT_SECRET)]) {
      expect(() => casePage({ items, user, limit: 20, cursor })).to.throw();
    }
    expect(() => casePage({ items, user: { ...user, username: 'other' }, limit: 20,
      cursor: page.nextCursor })).to.throw('this account');
  });

  it('rejects continuation if the visible case snapshot changes', () => {
    const page = casePage({ items, user, limit: 20 });
    try {
      casePage({ items: items.slice(1), user, limit: 20, cursor: page.nextCursor });
      throw new Error('expected stale snapshot rejection');
    } catch (error) {
      expect(error.status).to.equal(409);
    }
  });

  it('validates limits and cursor shapes without coercing arrays', () => {
    expect(validateQuery({})).to.deep.equal({ limit: 20, cursor: undefined });
    for (const limit of ['0', '-1', '51', '1.5', '2e1', ['20']]) {
      expect(() => validateQuery({ limit })).to.throw('limit');
    }
    for (const cursor of ['', ['x'], 'x'.repeat(2049)]) {
      expect(() => validateQuery({ cursor })).to.throw('cursor');
    }
  });

  it('requires authentication, validates before reading, and preserves the Fabric identity', async () => {
    const calls = [];
    const app = express();
    app.use('/api/mobile', createMobileRouter({ evaluate: async (...args) => {
      calls.push(args); return items;
    } }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/mobile/cases`;
    const headers = { Authorization: `Bearer ${jwt.sign(user, JWT_SECRET)}` };
    try {
      expect((await fetch(base)).status).to.equal(401);
      expect((await fetch(`${base}?limit=51`, { headers })).status).to.equal(400);
      expect(calls).to.have.length(0);
      const response = await fetch(`${base}?limit=20`, { headers });
      expect(response.status).to.equal(200);
      expect((await response.json()).data.items).to.have.length(20);
      expect(calls[0]).to.deep.equal(['police', 'mobile.fixture', 'GovernanceContract', 'QueryCases']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
