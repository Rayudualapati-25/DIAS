'use strict';

/**
 * LLM recommendations generated inside the backend.
 *
 * Once a request is committed and waits for the auditor, the backend asks the
 * LLM for an advisory ALLOW/DENY recommendation and keeps the answer off-chain
 * for the auditor screen. Requests are answered one at a time so the local model
 * server is never flooded, and entries a restart left pending are answered again.
 * A failed generation is stored as a status with no recommendation; the auditor
 * still decides.
 */

const {
  verifiedRequestHash,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const { RECOMMENDATION_STATE } = require('./reviewStore');

/** The stored, auditor-facing view of one recommender result. */
function recommendationRecord(result) {
  const output = result.recommendation;
  return {
    generationStatus: result.generationStatus,
    recommendation: output ? output.recommendation : null,
    reasonCode: output ? output.reason_code : null,
    reason: output ? output.reason : null,
    policyRefs: output ? output.policy_refs : [],
    missingEvidence: output ? output.missing_evidence : [],
    reviewFlags: output ? output.review_flags : [],
    errorCode: result.provenance.errorCode || null,
    provenance: result.provenance,
  };
}

function createRecommendationWorker({ store, recommender, log = console }) {
  if (!store || !recommender) throw new Error('recommendation worker requires a store and a recommender');
  let queue = Promise.resolve();
  const queued = new Set();

  async function generate(requestId) {
    const entry = store.read(requestId);
    if (!entry || entry.recommendationState !== RECOMMENDATION_STATE.PENDING) return null;
    let result;
    if (verifiedRequestHash(entry.verifiedRequest) !== entry.verifiedRequestHash) {
      // Facts that do not hash to the committed value are not something a
      // recommendation may be based on.
      result = recommender.unavailable({
        requestId,
        verifiedRequestHash: entry.verifiedRequestHash,
        justificationHash: null,
        generationStatus: 'UNAVAILABLE',
        errorCode: 'verified_request_hash_mismatch',
        errorDetail: 'the stored verified request does not hash to the committed verifiedRequestHash',
      });
    } else {
      result = await recommender.recommend({
        requestId,
        verifiedRequest: entry.verifiedRequest,
        justification: entry.justification,
      });
    }
    const record = recommendationRecord(result);
    store.update(requestId, { recommendationState: RECOMMENDATION_STATE.READY, recommendation: record });
    const summary = record.generationStatus === 'OK'
      ? `recommends ${record.recommendation} (${record.reasonCode})`
      : `no recommendation: ${record.generationStatus} (${record.errorCode})`;
    log.log(`[dias] ${requestId} -> ${summary}; ${record.provenance.latencyMs.total} ms`);
    return record;
  }

  /**
   * An unexpected error must not leave the entry pending, because the auditor
   * cannot decide while a recommendation is still expected.
   */
  function recordFailure(requestId, error) {
    log.error(`[dias] ${requestId} recommendation failed: ${error.message}`);
    try {
      const entry = store.read(requestId);
      if (!entry || entry.recommendationState !== RECOMMENDATION_STATE.PENDING) return;
      const result = recommender.unavailable({
        requestId,
        verifiedRequestHash: entry.verifiedRequestHash,
        justificationHash: null,
        generationStatus: 'UNAVAILABLE',
        errorCode: 'recommendation_failed',
        errorDetail: error.message,
      });
      store.update(requestId, {
        recommendationState: RECOMMENDATION_STATE.READY,
        recommendation: recommendationRecord(result),
      });
    } catch (storeError) {
      log.error(`[dias] ${requestId} failure could not be stored: ${storeError.message}`);
    }
  }

  /** Queue one request; a request already queued is not queued twice. */
  function enqueue(requestId) {
    if (queued.has(requestId)) return queue;
    queued.add(requestId);
    queue = queue
      .then(() => generate(requestId))
      .catch((error) => recordFailure(requestId, error))
      .finally(() => queued.delete(requestId));
    return queue;
  }

  /** Answer every entry a previous process left pending. */
  function resumePending() {
    const pending = store.list()
      .filter((entry) => entry.recommendationState === RECOMMENDATION_STATE.PENDING);
    for (const entry of pending) enqueue(entry.requestId);
    return pending.length;
  }

  return Object.freeze({ enqueue, resumePending, idle: () => queue });
}

module.exports = { createRecommendationWorker, recommendationRecord };
