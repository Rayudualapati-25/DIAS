'use strict';

/** Access-log classification tests; no Fabric network required. */

const { expect } = require('chai');
const { describe: classify, withResponseTarget } = require('../src/middleware/accessLogger');

const snapshot = (method, path, extra = {}) => ({ method, path, query: {}, body: {}, ...extra });

describe('accessLogger.describe', () => {
  it('records a fine-tuned LLM access request against its record', () => {
    const entry = classify(snapshot('POST', '/access/llm-request', {
      body: { recordId: 'REC-FIR-001', query: 'I need to view the metadata for record REC-FIR-001.' },
    }));
    expect(entry).to.deep.equal({ action: 'access.llm-request', target: { recordId: 'REC-FIR-001' } });
  });

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

  it('never logs the free-text query of an LLM request', () => {
    const entry = classify(snapshot('POST', '/access/llm-request', {
      body: { recordId: 'REC-FIR-001', query: 'sensitive narrative' },
    }));
    expect(JSON.stringify(entry)).to.not.contain('sensitive narrative');
  });

  it('records auditor decisions and dynamic-policy administration', () => {
    expect(classify(snapshot('POST', '/access/auditor/REQ-1/decision', {
      body: { decision: 'force-allow', note: 'sensitive rationale' },
    }))).to.deep.equal({
      action: 'dias.auditor.decision',
      target: { requestId: 'REQ-1', decision: 'force-allow' },
    });
    const hash = 'a'.repeat(64);
    expect(classify(snapshot('POST', `/access/dynamic-rules/${hash}/revoke`, {
      body: { reason: 'sensitive rationale' },
    }))).to.deep.equal({
      action: 'dias.dynamic-policy.revoke', target: { fingerprintHash: hash },
    });
    expect(classify(snapshot('GET', '/access/auditor/pending')))
      .to.deep.equal({ action: 'dias.auditor.queue.read', target: null });
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
    expect(classify(snapshot('POST', '/audit/verify-recommendation-reason/REQ-1')))
      .to.deep.equal({
        action: 'audit.verify.recommendation-reason', target: { requestId: 'REQ-1' },
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
    expect(classify(snapshot('GET', '/access/pending')))
      .to.deep.equal({ action: 'escalation.queue.read', target: null });
    expect(classify(snapshot('POST', '/access/REC-FIR-001/abc123/approve')))
      .to.deep.equal({ action: 'escalation.approve', target: { recordId: 'REC-FIR-001', decisionId: 'abc123' } });
    expect(classify(snapshot('GET', '/health'))).to.equal(null);
  });
});
