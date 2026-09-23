'use strict';

/**
 * Plain-language explanation endpoint.
 *
 * The decision itself is NOT computed here — it is read back from the
 * blockchain, then reworded. Reading it from the ledger (instead of trusting
 * what the browser sends) means nobody can request an explanation for a
 * decision they invented.
 */

const express = require('express');
const fabric = require('../fabric/gateway');
const ollama = require('../llm/ollama');
const { explainDecision } = require('../llm/explain');
const { ok, asyncRoute } = require('../util/respond');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/** Is the local model up? The UI uses this to show an honest status. */
router.get('/health', asyncRoute(async (req, res) => {
  const health = await ollama.isAvailable();
  return ok(res, health);
}));

router.post('/:recordId/:decisionId', asyncRoute(async (req, res) => {
  const { recordId, decisionId } = req.params;

  // Source of truth: the committed decision on the ledger.
  const decisionEvent = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'AccessContract', 'GetDecision',
    recordId, decisionId);

  const result = await explainDecision(decisionEvent);
  return ok(res, {
    recordId,
    decisionId,
    decision: decisionEvent.explanation.decision,
    reasonCode: decisionEvent.explanation.reasonCode,
    text: result.text,
    source: result.source,
    model: result.model,
    latencyMs: result.latencyMs,
    cached: result.cached,
    // Surfaced rather than hidden: if the model said something unsupported we
    // fell back to the template, and the reason is visible.
    problems: result.validation.problems,
    warnings: result.validation.warnings,
  });
}));

module.exports = router;
