'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { expect } = require('chai');
const { createReviewCipher } = require('../src/dias/reviewCipher');
const { createAccessEventOutbox } = require('../src/dias/accessEventOutbox');
const { createAccessLogger } = require('../src/middleware/accessLogger');

const silent = { error() {} };
const event = { org: 'police', fabricUser: 'insp.test', action: 'record.search',
  target: { filters: { recordId: 'FIR-1' } }, outcome: 'ok', status: 200 };

describe('durable application access events', () => {
  let dir;
  let cipher;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-access-outbox-'));
    cipher = createReviewCipher({ keyId: 'test', key: crypto.randomBytes(32) });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('retains an encrypted event on failure and retries the same identifier after restart', async () => {
    const calls = [];
    const failing = createAccessEventOutbox({ dir, cipher, log: silent,
      ledger: { submit: async (...args) => { calls.push(args); throw new Error('timeout'); } } });
    const id = failing.stage(event);
    const file = fs.readFileSync(path.join(dir, `${id}.json`), 'utf8');
    expect(file).not.to.contain('insp.test').and.not.to.contain('FIR-1');
    await failing.flush();
    expect(fs.existsSync(path.join(dir, `${id}.json`))).to.equal(true);
    const restarted = createAccessEventOutbox({ dir, cipher, log: silent,
      ledger: { submit: async (...args) => { calls.push(args); return { txId: 'confirmed' }; } } });
    await restarted.flush();
    expect(calls).to.have.length(2);
    expect(calls[0]).to.deep.equal(calls[1]);
    expect(calls[0].slice(0, 5)).to.deep.equal([
      'police', 'insp.test', 'AuditContract', 'RecordAccessEventOnce', id,
    ]);
    expect(fs.readdirSync(dir)).to.deep.equal([]);
  });

  it('never drops unreadable events or duplicates overlapping flush work', async () => {
    let calls = 0;
    const outbox = createAccessEventOutbox({ dir, cipher, log: silent,
      ledger: { submit: async () => { calls += 1; await Promise.resolve(); return {}; } } });
    const id = outbox.stage(event);
    await Promise.all([outbox.flush(), outbox.flush()]);
    expect(calls).to.equal(1);
    fs.writeFileSync(path.join(dir, `${id}.json`), 'broken');
    await outbox.flush();
    expect(fs.existsSync(path.join(dir, `${id}.json`))).to.equal(true);
    expect(calls).to.equal(1);
  });

  it('requires encryption rather than silently writing signing identities in clear text', () => {
    expect(() => createAccessEventOutbox({ dir, ledger: {} })).to.throw(/cipher/);
  });

  it('stages before the response ends and prevents release if staging fails', () => {
    const order = [];
    const request = { method: 'GET', originalUrl: '/api/records', query: { caseId: 'CASE-1' },
      user: { org: 'police', fabricUser: 'insp.test' } };
    const response = () => {
      const res = new EventEmitter();
      res.locals = {}; res.statusCode = 200; res.headersSent = false;
      res.removeHeader = () => {};
      res.setHeader = () => {};
      res.end = (body) => { order.push(['end', body]); return res; };
      return res;
    };
    const good = response();
    createAccessLogger({ outbox: { stage: () => { order.push(['stage']); }, flush: async () => {} },
      log: silent })(request, good, () => {});
    good.end('protected response');
    expect(order.map(([step]) => step)).to.deep.equal(['stage', 'end']);
    order.length = 0;
    const bad = response();
    createAccessLogger({ outbox: { stage: () => { throw new Error('disk full'); } },
      log: silent })(request, bad, () => {});
    bad.end('protected response');
    expect(bad.statusCode).to.equal(503);
    expect(order[0][1]).not.to.contain('protected response');
    expect(order[0][1]).to.contain('access log');
  });
});
