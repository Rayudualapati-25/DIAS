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
    expect(withResponseTarget(entry, { llmAgreement: 'NOT_AGREED' })).to.deep.equal({
      requestId: 'REQ-1', decision: 'FORCE_ALLOW', llmAgreement: 'NOT_AGREED',
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
