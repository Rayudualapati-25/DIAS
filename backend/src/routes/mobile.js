'use strict';

const express = require('express');
const fabric = require('../fabric/gateway');
const { requireAuth } = require('../middleware/auth');
const { ok, fail, asyncRoute } = require('../util/respond');
const { casePage, validateQuery } = require('../mobile/casePage');

function createMobileRouter(ledger = fabric) {
  const router = express.Router();
  router.use(requireAuth);
  router.get('/cases', asyncRoute(async (req, res) => {
    let query;
    try { query = validateQuery(req.query); } catch (error) {
      return fail(res, error.message, error.status);
    }
    // Existing ledger read and identity checks are retained. Only the HTTP response is paged; this is not a
    // CouchDB/Fabric pagination implementation.
    const items = await ledger.evaluate(
      req.user.org, req.user.fabricUser, 'GovernanceContract', 'QueryCases');
    try {
      return ok(res, casePage({ items, user: req.user, ...query }));
    } catch (error) {
      if (error.status) return fail(res, error.message, error.status);
      throw error;
    }
  }));
  return router;
}

module.exports = createMobileRouter();
module.exports.createMobileRouter = createMobileRouter;
