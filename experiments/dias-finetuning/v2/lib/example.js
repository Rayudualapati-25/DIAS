'use strict';

/**
 * One labelled example.
 *
 * The prompt is built by the SAME module the live recommendation service uses,
 * so training and serving cannot drift: if the prompt changes, this dataset is
 * stale by construction and the manifest's prompt version says so.
 *
 * The label has two independent sources, and neither is a judgement made here:
 *
 *   - decision, reason code, policy refs and the seal review flag come from the
 *     offline oracle applied to the verified facts;
 *   - the justification-dependent review flags come from the declaration on the
 *     justification family, because the oracle never sees the text.
 *
 * The validator recomputes both from the recorded facts and family id, so a
 * generator bug produces a validation failure rather than a plausible-looking
 * dataset.
 */

const crypto = require('crypto');
const {
  buildRecommendationMessages,
} = require('../../../../backend/src/dias/recommendationPrompt');
const {
  evaluateReference, referenceReason,
} = require('../../../../policies/reference-oracle/referencePolicyOracle');
const { flagsForFamily, renderJustification } = require('./justifications');

const RESPONSE_KEY_ORDER = Object.freeze([
  'recommendation', 'reason_code', 'reason', 'policy_refs', 'missing_evidence', 'review_flags',
]);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * The complete label for a set of facts and a justification family.
 * Review flags are the union of the two sources, in a fixed order so the label
 * is a deterministic function of its inputs.
 */
function labelFor(bundle, facts, justificationFamilyId) {
  const verdict = evaluateReference(bundle, facts);
  const flags = [...new Set([...verdict.review_flags, ...flagsForFamily(justificationFamilyId)])]
    .sort();
  return {
    recommendation: verdict.recommendation,
    reason_code: verdict.reason_code,
    reason: referenceReason(bundle, facts, verdict),
    policy_refs: [...verdict.policy_refs],
    // Policy v1 defines no evidence requirements; see docs/policies/policy-open-questions.md.
    missing_evidence: [],
    review_flags: flags,
  };
}

/** Facts a justification template may mention. Never includes the label. */
function surfaceFacts(rng, bundle, facts, identifiers, index) {
  const otherRoles = Object.keys(bundle.roles).filter((role) => role !== facts.requester.role);
  const otherClearances = bundle.vocabularies.clearanceOrder
    .filter((level) => level !== facts.requester.clearance);
  return {
    action: facts.request.action,
    purpose: facts.request.purpose,
    recordType: facts.resource.recordType,
    caseId: facts.resource.caseId,
    recordId: identifiers.recordId,
    // A claimed role or clearance is always different from the verified one, so
    // a contradictory template really does contradict something.
    claimedRole: rng.pick(otherRoles),
    claimedClearance: otherClearances.length > 0
      ? rng.pick(otherClearances) : facts.requester.clearance,
  };
}

/**
 * Assemble a complete example.
 *
 * @param {object} options
 * @param {object} options.bundle active governance policy bundle
 * @param {object} options.policyContext assembled context for this requester role
 * @param {object} options.facts verified request (requester/resource/request)
 * @param {object} options.identifiers { username, recordId, caseId }
 * @param {object} options.justification { familyId, templateIndex }
 * @param {object} options.provenance { familyId, scenario, targetClauses, splitGroup }
 */
function buildExample({
  bundle, policyContext, facts, identifiers, justification, provenance, rng,
}) {
  const surface = surfaceFacts(rng, bundle, facts, identifiers);
  const text = renderJustification(justification.familyId, justification.templateIndex, surface);
  const label = labelFor(bundle, facts, justification.familyId);
  const messages = buildRecommendationMessages({
    verifiedRequest: facts,
    policyContext,
    justification: text,
  });
  const completion = JSON.stringify(
    Object.fromEntries(RESPONSE_KEY_ORDER.map((key) => [key, label[key]]))
  );
  const promptText = messages.map((m) => `${m.role}:${m.content}`).join('\n');
  return {
    // The training record. MLX-LM reads `messages` and nothing else, so every
    // other field is metadata the training run ignores and the audit needs.
    messages: [...messages, { role: 'assistant', content: completion }],
    meta: {
      exampleId: identifiers.exampleId,
      scenarioFamily: provenance.familyId,
      splitGroup: provenance.splitGroup,
      scenario: provenance.scenario,
      targetClauses: provenance.targetClauses,
      justificationFamily: justification.familyId,
      justificationTemplateIndex: justification.templateIndex,
      justificationKind: provenance.justificationKind,
      username: identifiers.username,
      recordId: identifiers.recordId,
      caseId: facts.resource.caseId,
      verifiedRequest: facts,
      justification: text,
      label,
      promptHash: sha256(promptText),
      factsHash: sha256(JSON.stringify(facts)),
    },
  };
}

module.exports = { RESPONSE_KEY_ORDER, buildExample, labelFor, sha256, surfaceFacts };
