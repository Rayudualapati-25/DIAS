'use strict';

/** Access-log classification tests; no Fabric network required. */

const { expect } = require('chai');
const { describe: classify, withResponseTarget } = require('../src/middleware/accessLogger');

const snapshot = (method, path, extra = {}) => ({ method, path, query: {}, body: {}, ...extra });

describe('accessLogger.describe', () => {
  it('records a DIAS request action and correlates its Fabric request ID', () => {
    const entry = classify(snapshot('POST', '/access/request', {
      body: {
        recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
        justification: 'private free text',
      },
    }));
    expect(entry).to.deep.equal({
      action: 'access.request',
      target: { recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation' },
    });
    expect(JSON.stringify(entry)).to.not.contain('private free text');
    expect(withResponseTarget(entry, {
      requestId: 'REQ-1', processingPath: 'llm-auditor', ignored: 'not logged',
    })).to.deep.equal({
      recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
      requestId: 'REQ-1', processingPath: 'llm-auditor',
    });
  });

  it('classifies a direct record lookup as a search for that identifier', () => {
    expect(classify(snapshot('GET', '/records/lookup/REC-FIR-001'))).to.deep.equal({
      action: 'record.search', target: { filters: { recordId: 'REC-FIR-001' } },
    });
  });

  it('records auditor decisions without the auditor reason', () => {
    const entry = classify(snapshot('POST', '/access/auditor/REQ-1/decision', {
      body: { decision: 'FORCE_ALLOW', reason: 'sensitive rationale' },
    }));
    expect(entry).to.deep.equal({
      action: 'dias.auditor.decision',
      target: { requestId: 'REQ-1', decision: 'FORCE_ALLOW' },
    });
    expect(JSON.stringify(entry)).to.not.contain('sensitive rationale');
    expect(withResponseTarget(entry, {
      llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED',
    })).to.deep.equal({
      requestId: 'REQ-1', decision: 'FORCE_ALLOW',
      llmRecommendation: 'DENY', llmAgreement: 'NOT_AGREED',
    });
    expect(classify(snapshot('GET', '/access/auditor/pending')))
      .to.deep.equal({ action: 'dias.auditor.queue.read', target: null });
  });

  it('gives retired SEAL-era routes only a generic action and never their request body', () => {
    for (const [method, path] of [
      ['POST', '/access/llm-request'],
      ['POST', `/access/dynamic-rules/${'a'.repeat(64)}/revoke`],
      ['GET', '/access/pending'],
      ['POST', '/access/REC-FIR-001/abc123/approve'],
      ['POST', '/audit/verify-recommendation-reason/REQ-1'],
      ['POST', '/explain/REC-FIR-001/abc123'],
    ]) {
      const entry = classify(snapshot(method, path, {
        body: { recordId: 'REC-FIR-001', query: 'sensitive narrative', reason: 'sensitive rationale' },
      }));
      expect(entry.action, path).to.match(/^api\./);
      expect(entry.target, path).to.equal(null);
    }
  });

  it('names current DIAS request and authorization routes', () => {
    expect(classify(snapshot('GET', '/access/request/REQ-1'))).to.deep.equal({
      action: 'access.request.read', target: { requestId: 'REQ-1' },
    });
    expect(classify(snapshot('GET', '/access/request/REQ-1/trail'))).to.deep.equal({
      action: 'access.request.trail', target: { requestId: 'REQ-1' },
    });
    // Opening the model's reasoning behind a decision is its own logged action.
    expect(classify(snapshot('GET', '/access/request/REQ-1/recommendation'))).to.deep.equal({
      action: 'dias.recommendation.read', target: { requestId: 'REQ-1' },
    });
    expect(classify(snapshot('GET', '/access/dynamic-authorizations', {
      query: { status: 'all' },
    }))).to.deep.equal({
      action: 'dias.authorization.list', target: { status: 'all' },
    });
    expect(classify(snapshot('GET', '/access/dynamic-authorizations/AUTH-1/history')))
      .to.deep.equal({
        action: 'dias.authorization.history', target: { authorizationId: 'AUTH-1' },
      });
    expect(classify(snapshot('POST', '/access/dynamic-authorizations/AUTH-1/revoke')))
      .to.deep.equal({
        action: 'dias.authorization.revoke', target: { authorizationId: 'AUTH-1' },
      });
  });

  it('names a case read and current request audit routes', () => {
    expect(classify(snapshot('GET', '/cases/CASE-1'))).to.deep.equal({
      action: 'case.read', target: { caseId: 'CASE-1' },
    });
    expect(classify(snapshot('GET', '/audit/request-trail/REQ-1'))).to.deep.equal({
      action: 'audit.request-trail.read', target: { requestId: 'REQ-1' },
    });
  });

  it('records a gated metadata read as its own action with the decision that unlocked it', () => {
    const entry = classify(snapshot('GET', '/records/REC-FIR-001/metadata/abc123'));
    expect(entry).to.deep.equal({
      action: 'record.metadata.read',
      target: { recordId: 'REC-FIR-001', decisionId: 'abc123' },
    });
  });

  it('records reading one decision against its record and decision', () => {
    const entry = classify(snapshot('GET', '/access/decision/REC-FIR-001/abc123'));
    expect(entry).to.deep.equal({
      action: 'decision.read',
      target: { recordId: 'REC-FIR-001', decisionId: 'abc123' },
    });
  });

  it('does not mistake the document-request routes for a record called "document-requests"', () => {
    expect(classify(snapshot('GET', '/records/document-requests/mine')))
      .to.deep.equal({ action: 'document.request.list', target: null });
    expect(classify(snapshot('POST', '/records/document-requests/req-1/upload')))
      .to.deep.equal({ action: 'document.upload', target: { requestId: 'req-1' } });
    expect(classify(snapshot('GET', '/records/document-requests/req-1/content')))
      .to.deep.equal({ action: 'document.release', target: { requestId: 'req-1' } });
  });

  it('records a full-document request against its record and decision', () => {
    const entry = classify(snapshot('POST', '/records/REC-FIR-001/document-requests', {
      body: { decisionId: 'abc123' },
    }));
    expect(entry).to.deep.equal({
      action: 'document.request.create',
      target: { recordId: 'REC-FIR-001', decisionId: 'abc123' },
    });
  });

  it('names the case list instead of a generic api path', () => {
    expect(classify(snapshot('GET', '/cases'))).to.deep.equal({ action: 'case.list', target: null });
  });

  it('keeps existing classifications unchanged', () => {
    expect(classify(snapshot('GET', '/records/REC-FIR-001')))
      .to.deep.equal({ action: 'record.read', target: { recordId: 'REC-FIR-001' } });
    expect(classify(snapshot('GET', '/health'))).to.equal(null);
  });
});

describe('access-log policy (plan step 6)', () => {
  const {
    ACTION_CLASS, LOG_CLASS, logClassOf, parseAccessLogMode, shouldLog,
  } = require('../src/middleware/accessLogger');

  it('names every current API route with its own action', () => {
    const routes = [
      ['GET', '/access/decision-log', 'dias.decision-log.read'],
      ['POST', '/cases', 'case.create'],
      ['POST', '/cases/CASE-1/assign', 'case.assign'],
      ['POST', '/cases/CASE-1/workflow', 'case.workflow.advance'],
      ['GET', '/cases/CASE-1/workflow', 'case.workflow.read'],
      ['GET', '/users', 'user.list'],
      ['POST', '/users', 'user.create'],
      ['GET', '/users/insp.test', 'user.read'],
      ['GET', '/users/insp.test/history', 'user.history.read'],
      ['POST', '/users/insp.test/status', 'user.status'],
      ['GET', '/departments', 'department.list'],
      ['POST', '/departments', 'department.create'],
      ['POST', '/records/R-1/evidence/E-1/custody', 'evidence.custody.transfer'],
      ['GET', '/records/R-1/evidence/E-1/custody', 'evidence.custody.read'],
      ['GET', '/audit/access-log/verify', 'audit.accesslog.verify'],
    ];
    for (const [method, path, action] of routes) {
      expect(classify(snapshot(method, path)).action, `${method} ${path}`).to.equal(action);
    }
  });

  it('copies only identifiers into the new targets, never free text', () => {
    const entry = classify(snapshot('POST', '/users/insp.test/status', {
      body: { status: 'suspended', reason: 'sensitive narrative' },
    }));
    expect(entry).to.deep.equal({ action: 'user.status', target: { username: 'insp.test', status: 'suspended' } });
    expect(classify(snapshot('POST', '/cases/CASE-1/assign', { body: { userId: 'io.k', note: 'x' } })))
      .to.deep.equal({ action: 'case.assign', target: { caseId: 'CASE-1', userId: 'io.k' } });
  });

  it('gives every named action a class, and an unknown action the sensitive class', () => {
    for (const [action, logClass] of Object.entries(ACTION_CLASS)) {
      expect(Object.values(LOG_CLASS), action).to.include(logClass);
    }
    expect(logClassOf('api.access.llm-request')).to.equal(LOG_CLASS.SENSITIVE);
    expect(logClassOf('record.metadata.read')).to.equal(LOG_CLASS.SENSITIVE);
    expect(logClassOf('access.request')).to.equal(LOG_CLASS.LEDGER_WRITE);
    expect(logClassOf('auth.whoami')).to.equal(LOG_CLASS.ROUTINE);
  });

  it('in security mode logs sensitive reads always and other calls only when refused or failed', () => {
    const mode = 'security';
    expect(shouldLog({ mode, action: 'document.release', status: 200 })).to.equal(true);
    expect(shouldLog({ mode, action: 'dias.recommendation.read', status: 200 })).to.equal(true);
    expect(shouldLog({ mode, action: 'auth.login', status: 200 })).to.equal(true);
    // A successful write is already its own ledger transaction.
    expect(shouldLog({ mode, action: 'access.request', status: 202 })).to.equal(false);
    expect(shouldLog({ mode, action: 'dias.auditor.decision', status: 201 })).to.equal(false);
    expect(shouldLog({ mode, action: 'access.request', status: 422 })).to.equal(true);
    expect(shouldLog({ mode, action: 'dias.auditor.decision', status: 403 })).to.equal(true);
    expect(shouldLog({ mode, action: 'auth.whoami', status: 200 })).to.equal(false);
    expect(shouldLog({ mode, action: 'auth.whoami', status: 500 })).to.equal(true);
  });

  it('in all mode logs every call, as v2 did', () => {
    for (const action of ['access.request', 'auth.whoami', 'document.release', 'api.unknown']) {
      expect(shouldLog({ mode: 'all', action, status: 200 }), action).to.equal(true);
    }
  });

  it('defaults to security and refuses an unknown mode', () => {
    expect(parseAccessLogMode(undefined)).to.equal('security');
    expect(parseAccessLogMode('')).to.equal('security');
    expect(parseAccessLogMode('all')).to.equal('all');
    expect(() => parseAccessLogMode('none')).to.throw(/DIAS_ACCESS_LOG_MODE must be "security" or "all"/);
  });
});

describe('access-log policy coverage', () => {
  const { ACTION_CLASS } = require('../src/middleware/accessLogger');

  /** Every route the routers mount (src/routes/*.js), with an example path. */
  const ROUTES = [
    ['POST', '/auth/login'], ['GET', '/auth/me'],
    ['GET', '/cases'], ['GET', '/cases/C-1'], ['POST', '/cases'], ['POST', '/cases/C-1/assign'],
    ['POST', '/cases/C-1/workflow'], ['GET', '/cases/C-1/workflow'],
    ['GET', '/audit/trail/R-1'], ['POST', '/audit/verify-payload/R-1'], ['GET', '/audit/access-log'],
    ['GET', '/audit/access-log/verify'], ['GET', '/audit/request-trail/REQ-1'],
    ['POST', '/access/request'], ['GET', '/access/request/REQ-1'], ['GET', '/access/request/REQ-1/trail'],
    ['POST', '/access/request/REQ-1/cancel'],
    ['GET', '/access/decision-log'], ['GET', '/access/request/REQ-1/recommendation'],
    ['GET', '/access/record/R-1'], ['GET', '/access/decision/R-1/D-1'],
    ['GET', '/access/auditor/pending'], ['GET', '/access/auditor/REQ-1'],
    ['POST', '/access/auditor/REQ-1/decision'], ['GET', '/access/dynamic-authorizations'],
    ['GET', '/access/dynamic-authorizations/AUTH-1'], ['GET', '/access/dynamic-authorizations/AUTH-1/history'],
    ['POST', '/access/dynamic-authorizations/AUTH-1/revoke'],
    ['GET', '/users'], ['GET', '/users/u'], ['GET', '/users/u/history'], ['POST', '/users'],
    ['POST', '/users/u/status'], ['GET', '/departments'], ['POST', '/departments'],
    ['GET', '/records'], ['POST', '/records'], ['GET', '/records/lookup/R-1'],
    ['GET', '/records/document-requests/mine'], ['POST', '/records/document-requests/D-1/upload'],
    ['GET', '/records/document-requests/D-1/content'], ['POST', '/records/R-1/document-requests'],
    ['GET', '/records/R-1/metadata/D-1'], ['GET', '/records/R-1'], ['GET', '/records/R-1/payload'],
    ['POST', '/records/R-1/evidence'], ['GET', '/records/R-1/evidence'],
    ['GET', '/records/R-1/evidence/E-1/detail'], ['POST', '/records/R-1/evidence/E-1/custody'],
    ['GET', '/records/R-1/evidence/E-1/custody'], ['POST', '/records/R-1/seal'], ['POST', '/records/R-1/unseal'],
  ];

  it('classifies the action of every mounted route explicitly', () => {
    for (const [method, path] of ROUTES) {
      const { action } = classify(snapshot(method, path));
      expect(ACTION_CLASS, `${method} ${path} -> ${action}`).to.have.property(action);
    }
  });
});
