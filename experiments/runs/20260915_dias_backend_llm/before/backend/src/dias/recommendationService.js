'use strict';

/**
 * The DIAS recommendation service — the policy model as a network participant.
 *
 * It watches the ledger for requests that reached the LLM_RECOMMENDATION step,
 * reads back everything the model may see, runs Qwen off-chain, and records an
 * advisory ALLOW/DENY recommendation — or an explicit generation-failure status
 * — signed with the AI organisation's own identity.
 *
 * What it deliberately does NOT do:
 *   - it never grants or denies access, and never writes an access decision;
 *   - it never consults the offline reference policy oracle, and no rule engine
 *     is allowed to correct, replace or escalate what the model returned;
 *   - it never invents a recommendation when generation fails. A failure is a
 *     status, so the request still reaches the auditor with nothing recommended.
 *
 * Nothing reaches the model except through the chain: the verified attributes
 * come from ledger state the chaincode derived from the requester's certificate,
 * and the justification comes from a private collection the AI organisation is a
 * member of. The service is stateless apart from a block checkpoint, so a
 * restart replays whatever it missed rather than losing it.
 */

const fs = require('fs');
const path = require('path');
const {
  GENERATION_STATUS, RESPONSE_SCHEMA_VERSION,
} = require('../../../chaincode/crimerecords/lib/dias/recommendationSchema');
const {
  verifiedRequestHash,
} = require('../../../chaincode/crimerecords/lib/dias/verifiedRequest');
const {
  CHAINCODE_EVENT_NAME,
} = require('../../../chaincode/crimerecords/lib/dias/lifecycle');
const { PROMPT_VERSION } = require('./recommendationPrompt');

const AI_ORG = 'ai';
const AI_USER = 'llm-decider';
const CONTRACT = 'AccessContract';
const AWAITING_RECOMMENDATION = 'awaiting-recommendation';
const NEXT_STEP = 'LLM_RECOMMENDATION';

const utf8 = new TextDecoder();

/**
 * A checkpoint bound to one ledger. A checkpoint copied from another chain would
 * start the stream past the current head, and the only symptom is silence, so the
 * listener announces where it resumes from.
 */
function createCheckpointStore(file) {
  return {
    read() {
      try {
        const { nextBlock } = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof nextBlock === 'string' ? BigInt(nextBlock) : undefined;
      } catch {
        return undefined;
      }
    },
    write(nextBlock) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ nextBlock: nextBlock.toString() })}\n`);
    },
  };
}

/** A configuration mismatch the operator must fix; never recorded as a model failure. */
class RecommendationConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecommendationConfigurationError';
  }
}

/**
 * Facts the registration pins versus facts this build implements. A mismatch
 * means every submission would be rejected by chaincode provenance validation,
 * so it stops the listener instead of burning requests one at a time.
 */
function assertRegistrationMatchesBuild(model) {
  if (model.promptVersion !== PROMPT_VERSION) {
    throw new RecommendationConfigurationError(
      `active model registration pins prompt '${model.promptVersion}' but this build implements '${PROMPT_VERSION}'`
    );
  }
  if (model.responseSchemaVersion !== RESPONSE_SCHEMA_VERSION) {
    throw new RecommendationConfigurationError(
      `active model registration pins response schema '${model.responseSchemaVersion}' but this build implements '${RESPONSE_SCHEMA_VERSION}'`
    );
  }
}

/**
 * Integrity of what the AI organisation was given, checked before the model sees
 * anything. A justification whose bytes do not hash to the committed value, or a
 * verified request that does not hash to its committed hash, is not something a
 * recommendation may be based on.
 *
 * @returns {{errorCode: string, detail: string}|null}
 */
function integrityProblem(context) {
  if (context.justificationHashVerified !== true) {
    return {
      errorCode: 'justification_hash_mismatch',
      detail: 'the private justification does not hash to the committed justificationHash',
    };
  }
  let derived;
  try {
    derived = verifiedRequestHash(context.verifiedRequest);
  } catch (error) {
    return { errorCode: 'verified_request_invalid', detail: error.message };
  }
  if (derived !== context.verifiedRequestHash) {
    return {
      errorCode: 'verified_request_hash_mismatch',
      detail: 'the verified request does not hash to the committed verifiedRequestHash',
    };
  }
  return null;
}

/**
 * Answer one request. Returns what was recorded, or null when the request was
 * already handled — an earlier delivery of the same event, or a request that
 * moved on meanwhile. Safe to call repeatedly for the same request id.
 */
async function handleRequest(requestId, {
  fabric: ledger,
  recommenderFor,
  signer,
  policyBundleHash,
  log = console,
}) {
  let context;
  try {
    context = await ledger.evaluate(
      AI_ORG, AI_USER, CONTRACT, 'GetAccessRequestForRecommendation', requestId);
  } catch (error) {
    if (/does not exist/.test(error.message)) return null;
    throw error;
  }
  if (context.status !== AWAITING_RECOMMENDATION) return null;

  assertRegistrationMatchesBuild(context.model);
  const recommender = recommenderFor(context.model);

  const submission = await buildSubmission(context, {
    recommender, policyBundleHash, requestId,
  });
  const attestationSignature = signer.sign({
    requestId,
    verifiedRequestHash: context.verifiedRequestHash,
    justificationHash: context.justificationHash,
    generationStatus: submission.generationStatus,
    output: submission.recommendation,
    provenance: submission.provenance,
  });

  const recorded = submission.generationStatus === GENERATION_STATUS.OK
    ? await ledger.submit(
      AI_ORG, AI_USER, CONTRACT, 'SubmitLLMRecommendation',
      requestId,
      JSON.stringify(submission.recommendation),
      JSON.stringify(submission.provenance),
      attestationSignature)
    : await ledger.submit(
      AI_ORG, AI_USER, CONTRACT, 'RecordLLMRecommendationUnavailable',
      requestId,
      JSON.stringify({
        generationStatus: submission.generationStatus,
        errorCode: submission.provenance.errorCode || 'unspecified_failure',
      }),
      JSON.stringify(submission.provenance),
      attestationSignature);

  const summary = submission.generationStatus === GENERATION_STATUS.OK
    ? `recommends ${submission.recommendation.recommendation} (${submission.recommendation.reason_code})`
    : `no recommendation: ${submission.generationStatus} (${submission.provenance.errorCode})`;
  log.log(`[dias] ${requestId} -> ${summary}; pending auditor review; `
    + `${submission.provenance.latencyMs.total} ms total`);
  return recorded;
}

/**
 * Produce the submission for one request: either a schema-valid recommendation
 * or a failure status, with provenance this service generated in both cases.
 */
async function buildSubmission(context, { recommender, policyBundleHash, requestId }) {
  const problem = integrityProblem(context);
  if (problem) {
    return recommender.unavailable({
      requestId,
      verifiedRequestHash: context.verifiedRequestHash,
      justificationHash: context.justificationHash,
      generationStatus: GENERATION_STATUS.UNAVAILABLE,
      errorCode: problem.errorCode,
      errorDetail: problem.detail,
    });
  }
  // The bundle this service can read must be the bundle the ledger activated.
  // Recommending against a different bundle would cite clauses the chain never
  // agreed to, so it is a policy-context failure, not a model failure.
  if (policyBundleHash !== context.policyBundle.bundleHash) {
    return recommender.unavailable({
      requestId,
      verifiedRequestHash: context.verifiedRequestHash,
      justificationHash: context.justificationHash,
      generationStatus: GENERATION_STATUS.POLICY_CONTEXT_UNAVAILABLE,
      errorCode: 'policy_bundle_mismatch',
      errorDetail: `local bundle ${policyBundleHash} is not the active bundle ${context.policyBundle.bundleHash}`,
    });
  }
  return recommender.recommend({
    requestId,
    verifiedRequest: context.verifiedRequest,
    justification: context.justification,
  });
}

/**
 * Watch the ledger and answer every request that reaches the recommendation step.
 * Resolves only when the caller aborts the returned stream.
 */
async function run({
  fabric: ledger,
  recommenderFor,
  signer,
  policyBundleHash,
  log = console,
  signal,
  checkpoint,
} = {}) {
  const resumeFrom = checkpoint.read();
  const events = await ledger.chaincodeEvents(AI_ORG, AI_USER, resumeFrom);
  if (signal) signal.addEventListener('abort', () => events.close(), { once: true });
  log.log(`[dias] listening for ${CHAINCODE_EVENT_NAME} as AIOrgMSP/${AI_USER}`
    + (resumeFrom === undefined ? ' from the start of the channel' : ` from block ${resumeFrom}`));
  try {
    for await (const event of events) {
      const requestId = requestNeedingRecommendation(event);
      if (requestId === null) {
        // Resume from this block, not the next one. A Fabric block can hold
        // several chaincode events, and advancing past it after the first would
        // skip a later request. Replay is safe because handleRequest is
        // idempotent for requests that already moved on.
        checkpoint.write(event.blockNumber);
        continue;
      }
      try {
        await handleRequest(requestId, { fabric: ledger, recommenderFor, signer, policyBundleHash, log });
      } catch (error) {
        // Do not checkpoint a failed request: advancing here would make a
        // pending request unreachable, because a restart would begin after its
        // event. Stop so a supervised restart retries the same committed
        // request once the model or configuration is repaired.
        log.error(`[dias] ${requestId} could not be answered: ${error.message}`);
        throw error;
      }
      checkpoint.write(event.blockNumber);
    }
  } finally {
    events.close();
  }
}

/** The request id this event asks for a recommendation about, or null. */
function requestNeedingRecommendation(event) {
  if (event.eventName !== CHAINCODE_EVENT_NAME) return null;
  let payload;
  try {
    payload = JSON.parse(utf8.decode(event.payload));
  } catch {
    return null;
  }
  if (payload.nextStep !== NEXT_STEP) return null;
  return typeof payload.requestId === 'string' ? payload.requestId : null;
}

module.exports = {
  AI_ORG,
  AI_USER,
  AWAITING_RECOMMENDATION,
  NEXT_STEP,
  RecommendationConfigurationError,
  assertRegistrationMatchesBuild,
  buildSubmission,
  createCheckpointStore,
  handleRequest,
  integrityProblem,
  requestNeedingRecommendation,
  run,
};
