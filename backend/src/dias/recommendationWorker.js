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
const {
  requesterClaimsHash, validateRequesterClaims,
} = require('../../../chaincode/crimerecords/lib/dias/requesterClaims');
const { RECOMMENDATION_STATE } = require('./reviewStore');
const trace = require('../util/trace');

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

/** Why the stored inputs cannot be used, or null when they match their commitments. */
function inputMismatch(entry) {
  if (verifiedRequestHash(entry.verifiedRequest) !== entry.verifiedRequestHash) {
    return {
      errorCode: 'verified_request_hash_mismatch',
      errorDetail: 'the stored verified request does not hash to the committed verifiedRequestHash',
    };
  }
  if (validateRequesterClaims(entry.requesterClaims).length > 0
      || requesterClaimsHash(entry.requesterClaims) !== entry.requesterClaimsHash) {
    return {
      errorCode: 'requester_claims_hash_mismatch',
      errorDetail: 'the stored requester claims do not hash to the committed requesterClaimsHash',
    };
  }
  return null;
}

function createRecommendationWorker({ store, recommender, log = console }) {
  if (!store || !recommender) throw new Error('recommendation worker requires a store and a recommender');
  let queue = Promise.resolve();
  const queued = new Set();

  async function generate(requestId) {
    const entry = store.read(requestId);
    if (!entry || entry.recommendationState !== RECOMMENDATION_STATE.PENDING) return null;
    trace.emit('recommendation.started', { requestId });
    // Facts or claims that do not hash to the committed values are not something
    // a recommendation may be based on.
    const mismatch = inputMismatch(entry);
    let result;
    if (mismatch) {
      result = recommender.unavailable({
        requestId,
        verifiedRequestHash: entry.verifiedRequestHash,
        requesterClaimsHash: entry.requesterClaimsHash || null,
        justificationHash: null,
        generationStatus: 'UNAVAILABLE',
        errorCode: mismatch.errorCode,
        errorDetail: mismatch.errorDetail,
      });
    } else {
      result = await recommender.recommend({
        requestId,
        verifiedRequest: entry.verifiedRequest,
        requesterClaims: entry.requesterClaims,
        justification: entry.justification,
      });
    }
    const record = recommendationRecord(result);
    store.update(requestId, { recommendationState: RECOMMENDATION_STATE.READY, recommendation: record });
    trace.emit('recommendation.ready', {
      requestId,
      generationStatus: record.generationStatus,
      recommendation: record.recommendation,
      reasonCode: record.reasonCode,
      latencyMs: record.provenance.latencyMs,
      usage: record.provenance.usage || null,
    });
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
    trace.emit('recommendation.enqueued', { requestId, queued: queued.size });
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
