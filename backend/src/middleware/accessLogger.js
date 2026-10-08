'use strict';

/**
 * Records authenticated API calls directly on the Fabric ledger.
 *
 * Runs AFTER the response has been sent, so logging never slows a request down
 * and never turns a logging bug into a failed request.
 *
 * Only who/what/when is recorded — never the case narrative, the payload
 * contents or a token. Search filters ARE recorded, because "who
 * went looking for this case" is exactly the signal an auditor needs.
 */

const fabric = require('../fabric/gateway');

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** A body value copied into a log target only when it is a plain identifier. */
const identifier = (value) => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);

/**
 * Map a request to a stable action name and a safe target.
 * Returns null for requests that are not worth logging (health checks, statics).
 *
 * Takes a snapshot { method, path, query, body } rather than the live request:
 * Express rewrites req.url while nested routers dispatch, so by the time the
 * response has finished the path no longer identifies the route.
 */
function describe(snapshot) {
  const path = snapshot.path;
  const method = snapshot.method;
  const req = { query: snapshot.query || {}, body: snapshot.body || {} };

  if (path === '/health') return null;

  // Auth
  if (path === '/auth/login') {
    return { action: 'auth.login', target: { username: req.body && req.body.username } };
  }
  if (path === '/auth/me') return { action: 'auth.whoami', target: null };

  // Records
  if (path === '/records' && method === 'GET') {
    // The search filters are the investigative signal, so they are logged.
    return { action: 'record.search', target: { filters: req.query } };
  }
  if (path === '/records' && method === 'POST') {
    return { action: 'record.create', target: { recordId: req.body && req.body.recordId } };
  }
  const recordLookupMatch = path.match(/^\/records\/lookup\/([^/]+)$/);
  if (recordLookupMatch) {
    return {
      action: 'record.search',
      target: { filters: { recordId: recordLookupMatch[1] } },
    };
  }
  // The full-document (PDF) workflow shares the /records prefix but names a
  // request rather than a record, so it is classified before the record routes.
  if (path === '/records/document-requests/mine') {
    return { action: 'document.request.list', target: null };
  }
  const documentMatch = path.match(/^\/records\/document-requests\/([^/]+)\/(upload|content)$/);
  if (documentMatch) {
    return {
      action: documentMatch[2] === 'upload' ? 'document.upload' : 'document.release',
      target: { requestId: documentMatch[1] },
    };
  }
  const recordMatch = path.match(/^\/records\/([^/]+)(\/.*)?$/);
  if (recordMatch) {
    const recordId = recordMatch[1];
    const rest = recordMatch[2] || '';
    if (rest === '/payload') return { action: 'payload.release', target: { recordId } };
    if (rest === '/document-requests') {
      return {
        action: 'document.request.create',
        target: { recordId, decisionId: req.body && req.body.decisionId },
      };
    }
    const metadataMatch = rest.match(/^\/metadata\/([^/]+)$/);
    if (metadataMatch) {
      // "Get details" after an ALLOW: the decision that unlocked the metadata is the signal.
      return { action: 'record.metadata.read', target: { recordId, decisionId: metadataMatch[1] } };
    }
    const custodyMatch = rest.match(/^\/evidence\/([^/]+)\/custody$/);
    if (custodyMatch) {
      return {
        action: method === 'POST' ? 'evidence.custody.transfer' : 'evidence.custody.read',
        target: { recordId, evidenceId: custodyMatch[1] },
      };
    }
    if (rest.endsWith('/detail')) return { action: 'evidence.detail.read', target: { recordId } };
    if (rest === '/evidence') {
      return {
        action: method === 'POST' ? 'evidence.attach' : 'evidence.list',
        target: { recordId },
      };
    }
    if (rest === '/seal') return { action: 'record.seal', target: { recordId } };
    if (rest === '/unseal') return { action: 'record.unseal', target: { recordId } };
    return { action: 'record.read', target: { recordId } };
  }

  // Cases
  if (path === '/cases' && method === 'GET') return { action: 'case.list', target: null };
  if (path === '/cases' && method === 'POST') {
    return { action: 'case.create', target: { caseId: identifier(req.body.caseId) } };
  }
  const caseActionMatch = path.match(/^\/cases\/([^/]+)\/(assign|workflow)$/);
  if (caseActionMatch) {
    const caseId = caseActionMatch[1];
    if (caseActionMatch[2] === 'assign') {
      return { action: 'case.assign', target: { caseId, userId: identifier(req.body.userId) } };
    }
    return method === 'POST'
      ? { action: 'case.workflow.advance', target: { caseId, nextStatus: identifier(req.body.nextStatus) } }
      : { action: 'case.workflow.read', target: { caseId } };
  }

  // Users and departments
  if (path === '/users') {
    return method === 'POST'
      ? { action: 'user.create', target: { username: identifier(req.body.username) } }
      : { action: 'user.list', target: null };
  }
  const userMatch = path.match(/^\/users\/([^/]+)(?:\/(history|status))?$/);
  if (userMatch) {
    const username = userMatch[1];
    if (userMatch[2] === 'status') {
      return { action: 'user.status', target: { username, status: identifier(req.body.status) } };
    }
    return { action: userMatch[2] ? 'user.history.read' : 'user.read', target: { username } };
  }
  if (path === '/departments') {
    return method === 'POST'
      ? { action: 'department.create', target: { departmentId: identifier(req.body.departmentId) } }
      : { action: 'department.list', target: null };
  }
  const caseReadMatch = path.match(/^\/cases\/([^/]+)$/);
  if (caseReadMatch && method === 'GET') {
    return { action: 'case.read', target: { caseId: caseReadMatch[1] } };
  }

  // Access decisions
  if (path === '/access/request') {
    return {
      action: 'access.request',
      target: {
        recordId: req.body && req.body.recordId,
        action: req.body && req.body.action,
        purpose: req.body && req.body.purpose,
      },
    };
  }
  if (path === '/access/decision-log') return { action: 'dias.decision-log.read', target: null };
  // Who opened the model's reasoning behind a decision is itself worth logging.
  const recommendationMatch = path.match(/^\/access\/request\/([^/]+)\/recommendation$/);
  if (recommendationMatch) {
    return {
      action: 'dias.recommendation.read',
      target: { requestId: recommendationMatch[1] },
    };
  }
  const cancelMatch = path.match(/^\/access\/request\/([^/]+)\/cancel$/);
  if (cancelMatch) return { action: 'access.request.cancel', target: { requestId: cancelMatch[1] } };
  const accessRequestMatch = path.match(/^\/access\/request\/([^/]+)(\/trail)?$/);
  if (accessRequestMatch) {
    return {
      action: accessRequestMatch[2] ? 'access.request.trail' : 'access.request.read',
      target: { requestId: accessRequestMatch[1] },
    };
  }
  if (path === '/access/auditor/pending') {
    return { action: 'dias.auditor.queue.read', target: null };
  }
  // The auditor screen's automatic "is it ready yet" check: no case data is read.
  if (path === '/access/auditor/pending/status') {
    return { action: 'dias.auditor.queue.status', target: null };
  }
  const auditorDecisionMatch = path.match(/^\/access\/auditor\/([^/]+)\/decision$/);
  if (auditorDecisionMatch) {
    return {
      action: 'dias.auditor.decision',
      target: {
        requestId: auditorDecisionMatch[1],
        decision: req.body && req.body.decision,
      },
    };
  }
  const auditorReviewMatch = path.match(/^\/access\/auditor\/([^/]+)$/);
  if (auditorReviewMatch) {
    return {
      action: 'dias.auditor.review.read',
      target: { requestId: auditorReviewMatch[1] },
    };
  }
  if (path === '/access/dynamic-authorizations') {
    return { action: 'dias.authorization.list', target: { status: req.query.status } };
  }
  const authorizationMatch = path.match(
    /^\/access\/dynamic-authorizations\/([^/]+)(?:\/(history|revoke))?$/
  );
  if (authorizationMatch) {
    return {
      action: `dias.authorization.${authorizationMatch[2] || 'read'}`,
      target: { authorizationId: authorizationMatch[1] },
    };
  }
  const decisionMatch = path.match(/^\/access\/decision\/([^/]+)\/([^/]+)$/);
  if (decisionMatch) {
    return {
      action: 'decision.read',
      target: { recordId: decisionMatch[1], decisionId: decisionMatch[2] },
    };
  }
  if (path.startsWith('/access/record/')) {
    return { action: 'decision.list', target: { recordId: path.split('/').pop() } };
  }

  // Audit
  if (path.startsWith('/audit/trail/')) {
    return { action: 'audit.trail.read', target: { recordId: path.split('/').pop() } };
  }
  if (path.startsWith('/audit/verify-payload/')) {
    return { action: 'audit.verify.payload', target: { recordId: path.split('/').pop() } };
  }
  if (path.startsWith('/audit/request-trail/')) {
    return { action: 'audit.request-trail.read', target: { requestId: path.split('/').pop() } };
  }
  if (path === '/audit/access-log/verify') return { action: 'audit.accesslog.verify', target: null };
  if (path.startsWith('/audit/access-log')) {
    return { action: 'audit.accesslog.read', target: null };
  }

  // Anything else, including retired routes, is logged by path only: no body
  // field of an unrecognised request is ever copied into the ledger.
  return { action: `api${path.replace(/\//g, '.')}`, target: null };
}

/** Add only server-verified response fields to a DIAS request log target. */
function withResponseTarget(described, responseTarget) {
  if (!responseTarget) return described.target;
  const extra = {};
  if (described.action === 'access.request') {
    if (typeof responseTarget.requestId === 'string') extra.requestId = responseTarget.requestId;
    if (typeof responseTarget.processingPath === 'string') {
      extra.processingPath = responseTarget.processingPath;
    }
  }
  if (described.action === 'dias.auditor.decision') {
    if (typeof responseTarget.llmRecommendation === 'string') {
      extra.llmRecommendation = responseTarget.llmRecommendation;
    }
    if (typeof responseTarget.llmAgreement === 'string') {
      extra.llmAgreement = responseTarget.llmAgreement;
    }
  }
  return Object.keys(extra).length === 0 ? described.target : { ...described.target, ...extra };
}

/**
 * Logging policy (docs/design/dias-v3-ledger-schema.md §12).
 *
 *   SENSITIVE     reads of protected or personal data, identity events and
 *                 searches: logged in every mode, because the read itself leaves
 *                 no other trace;
 *   LEDGER_WRITE  calls that submit their own transaction: a success is already
 *                 its own ledger record, so it is logged only when refused or
 *                 failed;
 *   ROUTINE       low-value reads: logged only when refused or failed.
 *
 * DIAS_ACCESS_LOG_MODE=security applies the classes (the v3 default);
 * DIAS_ACCESS_LOG_MODE=all logs every attributable call, as v2 did, so v2 runs
 * can be reproduced. An action without a class is treated as SENSITIVE.
 */
const LOG_CLASS = Object.freeze({
  SENSITIVE: 'sensitive',
  LEDGER_WRITE: 'ledger-write',
  ROUTINE: 'routine',
});
const { SENSITIVE, LEDGER_WRITE, ROUTINE } = LOG_CLASS;

const ACTION_CLASS = Object.freeze({
  'auth.login': SENSITIVE,
  'auth.login_failed': SENSITIVE,
  'auth.whoami': ROUTINE,
  'record.search': SENSITIVE,
  'record.create': LEDGER_WRITE,
  'record.read': SENSITIVE,
  'record.metadata.read': SENSITIVE,
  'record.seal': LEDGER_WRITE,
  'record.unseal': LEDGER_WRITE,
  'payload.release': SENSITIVE,
  'document.request.list': ROUTINE,
  'document.request.create': LEDGER_WRITE,
  'document.upload': LEDGER_WRITE,
  'document.release': SENSITIVE,
  'evidence.attach': LEDGER_WRITE,
  'evidence.list': SENSITIVE,
  'evidence.detail.read': SENSITIVE,
  'evidence.custody.transfer': LEDGER_WRITE,
  'evidence.custody.read': SENSITIVE,
  'case.list': ROUTINE,
  'case.read': SENSITIVE,
  'case.create': LEDGER_WRITE,
  'case.assign': LEDGER_WRITE,
  'case.workflow.advance': LEDGER_WRITE,
  'case.workflow.read': SENSITIVE,
  'user.list': SENSITIVE,
  'user.read': SENSITIVE,
  'user.history.read': SENSITIVE,
  'user.create': LEDGER_WRITE,
  'user.status': LEDGER_WRITE,
  'department.list': ROUTINE,
  'department.create': LEDGER_WRITE,
  'access.request': LEDGER_WRITE,
  'access.request.read': SENSITIVE,
  'access.request.cancel': LEDGER_WRITE,
  'access.request.trail': SENSITIVE,
  'dias.decision-log.read': SENSITIVE,
  'dias.recommendation.read': SENSITIVE,
  'dias.auditor.queue.read': SENSITIVE,
  'dias.auditor.queue.status': ROUTINE,
  'dias.auditor.review.read': SENSITIVE,
  'dias.auditor.decision': LEDGER_WRITE,
  'dias.authorization.list': SENSITIVE,
  'dias.authorization.read': SENSITIVE,
  'dias.authorization.history': SENSITIVE,
  'dias.authorization.revoke': LEDGER_WRITE,
  'decision.read': SENSITIVE,
  'decision.list': SENSITIVE,
  'audit.trail.read': SENSITIVE,
  'audit.verify.payload': SENSITIVE,
  'audit.request-trail.read': SENSITIVE,
  'audit.accesslog.read': SENSITIVE,
  'audit.accesslog.verify': SENSITIVE,
});

const logClassOf = (action) => ACTION_CLASS[action] || SENSITIVE;

function shouldLog({ mode, action, status }) {
  if (mode === 'all') return true;
  return logClassOf(action) === SENSITIVE || status >= 400;
}

function parseAccessLogMode(value) {
  if (value === undefined || value === null || value === '') return 'security';
  if (value === 'security' || value === 'all') return value;
  throw new Error('[config] DIAS_ACCESS_LOG_MODE must be "security" or "all"');
}

/** Read once at start-up so a bad value stops the server instead of every request. */
const ACCESS_LOG_MODE = parseAccessLogMode(process.env.DIAS_ACCESS_LOG_MODE);

function outcomeFor(status, action) {
  if (status >= 500) return 'error';
  if (status === 401 || status === 403) {
    return action === 'auth.login' ? 'failed' : 'refused';
  }
  if (status >= 400) return 'rejected';
  return 'ok';
}

function accessLogger(req, res, next) {
  // Snapshot now: req.url is mutated by nested routers before 'finish' fires.
  // req.originalUrl is the one field Express never rewrites.
  const snapshot = {
    method: req.method,
    path: req.originalUrl.split('?')[0].replace(/^\/api/, '') || '/',
    query: { ...req.query },
    body: req.body && typeof req.body === 'object' ? { ...req.body } : {},
  };

  res.on('finish', async () => {
    try {
      const described = describe(snapshot);
      if (!described) return;

      const user = req.user || {};
      // Fabric needs a signing identity. Failed/anonymous logins are reported
      // by the web server but cannot honestly be attributed on-chain.
      if (!user.org || !user.fabricUser) return;
      const action = described.action === 'auth.login' && res.statusCode !== 200
        ? 'auth.login_failed'
        : described.action;
      if (!shouldLog({ mode: ACCESS_LOG_MODE, action, status: res.statusCode })) return;

      await fabric.submit(
        user.org, user.fabricUser, 'AuditContract', 'RecordAccessEvent',
        action, JSON.stringify(withResponseTarget(described, res.locals.accessEventTarget)),
        outcomeFor(res.statusCode, described.action), String(res.statusCode)
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[accessLogger] failed to record entry:', err.message);
    }
  });
  next();
}

module.exports = {
  ACCESS_LOG_MODE,
  ACTION_CLASS,
  LOG_CLASS,
  accessLogger,
  describe,
  logClassOf,
  parseAccessLogMode,
  shouldLog,
  withResponseTarget,
};
