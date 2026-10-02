'use strict';

/**
 * Recommendations, committed before review (design §6, §11).
 *
 * Once a request is committed and waits for the auditor, the worker asks the
 * recommendation service for an advisory recommendation. The service returns
 * the recommendation object M and a signed commitment κ. The worker stores both
 * (state `signed`) BEFORE submitting κ, so a crash or a lost response never loses
 * what was signed: a `signed` entry is resubmitted unchanged, which the contract
 * treats as a safe retry, and an uncertain submission is resolved by reading κ
 * back from the ledger.
 *
 * States: pending → signed → committed, or commit-rejected when the ledger
 * refuses κ for a reason a retry cannot fix (expired, stale policy, mismatch),
 * or failed when the service itself could not answer. Requests are answered one
 * at a time so the model server is never flooded.
 */

const { RECOMMENDATION_STATE } = require('./reviewStore');
const { sameCommitment } = require('../../../chaincode/crimerecords/lib/dias/recommendationCommitment');
const trace = require('../util/trace');

const CONTRACT = 'AccessContract';
const LASTING_REFUSAL = /DIAS_(REQUEST_EXPIRED|STALE_POLICY|COMMITMENT_MISMATCH|COMMITMENT_CONFLICT|SIGNATURE_INVALID|SIGNER_INACTIVE|LEGACY_RECORD)|is not awaiting-auditor|does not exist/;

/** The stored, auditor-facing view of one recommender result. */
function recommendationRecord(result) {
  const output = result.recommendation;
  const provenance = result.provenance || {};
  return {
    generationStatus: result.generationStatus,
    recommendation: output ? output.recommendation : null,
    reasonCode: output ? output.reason_code : null,
    reason: output ? output.reason : null,
    policyRefs: output ? output.policy_refs : [],
    missingEvidence: output ? output.missing_evidence : [],
    reviewFlags: output ? output.review_flags : [],
    errorCode: provenance.errorCode || null,
    provenance,
  };
}

/** The contract's sentence from a gateway error, or the error message. */
function chaincodeMessage(error) {
  if (error && Array.isArray(error.details) && error.details.length > 0) {
    return error.details.map((detail) => String(detail.message).replace(/^chaincode response \d+,\s*/i, ''))
      .join('; ');
  }
  return String((error && error.message) || error);
}

function serviceInput(requestId, entry) {
  return {
    requestId,
    verifiedRequest: entry.verifiedRequest,
    verifiedRequestHash: entry.verifiedRequestHash,
    requesterClaims: entry.requesterClaims,
    requesterClaimsHash: entry.requesterClaimsHash,
    justification: entry.justification,
    justificationHash: entry.justificationHash,
    policyVersion: entry.policyVersion,
    policyHash: entry.policyHash,
  };
}

function createRecommendationWorker({ store, service, ledger, relay, log = console }) {
  if (!store || !service || !ledger || !relay) {
    throw new Error('recommendation worker requires a store, a recommendation service, a ledger and a relay identity');
  }
  let queue = Promise.resolve();
  const queued = new Set();

  async function produce(requestId, entry) {
    trace.emit('recommendation.started', { requestId });
    const produced = await service.recommend(serviceInput(requestId, entry));
    const record = recommendationRecord(produced.result);
    const latencyMs = record.provenance.latencyMs || null;
    trace.emit('recommendation.ready', {
      requestId,
      generationStatus: record.generationStatus,
      recommendation: record.recommendation,
      reasonCode: record.reasonCode,
      latencyMs,
      usage: record.provenance.usage || null,
    });
    return store.update(requestId, {
      recommendationState: RECOMMENDATION_STATE.SIGNED,
      recommendation: record,
      recommendationObject: produced.recommendationObject,
      recommendationHash: produced.recommendationHash,
      commitment: produced.commitment,
      generationMetrics: { latencyMs, usage: record.provenance.usage || null },
    });
  }

  async function commit(requestId, entry) {
    try {
      const committed = await ledger.submit(
        relay.org, relay.fabricUser, CONTRACT, 'CommitRecommendation', requestId, JSON.stringify(entry.commitment)
      );
      store.update(requestId, {
        recommendationState: RECOMMENDATION_STATE.COMMITTED,
        commitmentId: committed.commitmentId,
        commitmentTxId: committed.txId,
      });
      log.log(`[dias] ${requestId} -> committed ${entry.commitment.generationStatus} ${entry.commitment.recommendation || ''}`);
      return;
    } catch (error) {
      const message = chaincodeMessage(error);
      // An uncertain failure (timeout, lost response) may still have committed κ.
      const onLedger = await ledger.evaluate(
        relay.org, relay.fabricUser, CONTRACT, 'GetRecommendationCommitment', requestId
      ).catch(() => null);
      if (onLedger && sameCommitment(onLedger, entry.commitment)) {
        store.update(requestId, {
          recommendationState: RECOMMENDATION_STATE.COMMITTED,
          commitmentId: onLedger.commitmentId,
          commitmentTxId: onLedger.txId,
        });
        return;
      }
      if (LASTING_REFUSAL.test(message)) {
        store.update(requestId, { recommendationState: RECOMMENDATION_STATE.COMMIT_REJECTED, commitError: message });
        log.error(`[dias] ${requestId} commitment refused: ${message}`);
        return;
      }
      // Leave it signed: the next enqueue or restart resubmits it unchanged.
      log.error(`[dias] ${requestId} commitment not confirmed, will retry: ${message}`);
    }
  }

  async function generate(requestId) {
    let entry = store.read(requestId);
    if (!entry) return;
    if (entry.recommendationState === RECOMMENDATION_STATE.PENDING) entry = await produce(requestId, entry);
    if (entry.recommendationState === RECOMMENDATION_STATE.SIGNED) await commit(requestId, entry);
  }

  /** The service could not answer at all: the auditor decides without a recommendation. */
  function recordFailure(requestId, error) {
    log.error(`[dias] ${requestId} recommendation failed: ${error.message}`);
    try {
      const entry = store.read(requestId);
      if (!entry || entry.recommendationState !== RECOMMENDATION_STATE.PENDING) return;
      store.update(requestId, {
        recommendationState: RECOMMENDATION_STATE.FAILED,
        recommendation: recommendationRecord({
          generationStatus: 'UNAVAILABLE',
          recommendation: null,
          provenance: { errorCode: 'recommendation_failed', errorDetail: String(error.message).slice(0, 300) },
        }),
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

  /** Answer every entry a previous process left pending, and resubmit every signed one. */
  function resumePending() {
    const unfinished = store.list().filter((entry) => [
      RECOMMENDATION_STATE.PENDING, RECOMMENDATION_STATE.SIGNED,
    ].includes(entry.recommendationState));
    for (const entry of unfinished) enqueue(entry.requestId);
    return unfinished.length;
  }

  return Object.freeze({ enqueue, resumePending, idle: () => queue });
}

module.exports = { createRecommendationWorker, recommendationRecord };
