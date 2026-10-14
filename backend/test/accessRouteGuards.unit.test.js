'use strict';

/**
 * Which access routes carry a role guard of their own. The contract is the real boundary; a guard here only
 * refuses early.
 */

const { expect } = require('chai');
const router = require('../src/routes/access');
const auditRouter = require('../src/routes/audit');
const { requireAuth } = require('../src/middleware/auth');

/** How many handlers one route runs: 1 is the handler alone, 2 is a role guard and the handler. */
function handlers(method, path, routes = router) {
  const layer = routes.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${path}`);
  return layer.route.stack.length;
}

describe('role guards on the access routes', () => {
  it('lets every signed-in officer ask for the access log; the contract decides what each one reads', () => {
    for (const path of ['/workflow-log', '/decision-log', '/requests/mine']) {
      expect(handlers('get', path), path).to.equal(1);
    }
  });

  it('asks for a signed-in identity before any access or audit route runs', () => {
    // With no role guard left on the access log, this is its only check before the contract.
    for (const routes of [router, auditRouter]) {
      expect(routes.stack[0].route, 'the first layer is middleware, not a route').to.equal(undefined);
      expect(routes.stack[0].handle).to.equal(requireAuth);
    }
  });

  it('keeps the searches-and-reads log behind the reviewer roles', () => {
    expect(handlers('get', '/access-log', auditRouter)).to.equal(2);
    expect(handlers('get', '/access-log/verify', auditRouter)).to.equal(2);
  });

  it('keeps the auditor and authorization routes behind the district-head role', () => {
    for (const path of ['/auditor/pending', '/auditor/pending/status', '/auditor/:requestId', '/dynamic-authorizations']) {
      expect(handlers('get', path), path).to.equal(2);
    }
    expect(handlers('post', '/auditor/:requestId/decision')).to.equal(2);
    expect(handlers('post', '/dynamic-authorizations/:authorizationId/revoke')).to.equal(2);
  });
});
