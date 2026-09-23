'use strict';

/**
 * Evaluation runner.
 *
 * Calls the model through the SAME recommender the live service uses, so an
 * evaluation number describes the deployed path rather than a parallel one built
 * for measuring. That means generation failures are surfaced as statuses here
 * exactly as they are on the ledger, and the metrics can separate "wrong" from
 * "absent".
 *
 * Decoding is fixed: temperature 0, top_p 1, thinking disabled, a fixed token
 * budget. Nothing about the run is sampled, so a rerun on the same server
 * reproduces the same predictions.
 */

const fs = require('fs');
const path = require('path');

const { createPolicyContextProvider } = require('../../../../backend/src/dias/policyContextProvider');
const { createRecommender } = require('../../../../backend/src/dias/recommender');
const { PROMPT_VERSION } = require('../../../../backend/src/dias/recommendationPrompt');
const {
  RESPONSE_SCHEMA_VERSION,
} = require('../../../../chaincode/crimerecords/lib/dias/recommendationSchema');
const { loadBundle } = require('../../../../policies/lib/bundle');

const DEFAULT_SETS = Object.freeze([
  'validation-balanced', 'test-decision-balanced', 'test-reason-balanced',
  'test-adversarial', 'test-ood-paraphrase', 'test-multi-rule',
]);

function readCases(datasetDir, name) {
  return fs.readFileSync(path.join(datasetDir, `${name}.cases.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Build a recommender pointed at one served model.
 *
 * `modelIdentity` is descriptive here rather than ledger-derived: an evaluation
 * is off-chain, so nothing verifies it. It is recorded verbatim in the results
 * so a number can always be traced to the weights that produced it.
 */
function createEvaluationRecommender({ url, servedModel, adapterPath, modelIdentity, maxTokens, timeoutMs }) {
  return createRecommender({
    policyContextProvider: createPolicyContextProvider({}),
    model: { ...modelIdentity, url, servedModel, adapterPath: adapterPath || null },
    options: { maxTokens, timeoutMs, maxPromptChars: 32000 },
  });
}

/** Run one set. Progress is reported so a long run is not a silent one. */
async function evaluateSet({ recommender, cases, onProgress }) {
  const results = [];
  for (let i = 0; i < cases.length; i += 1) {
    const example = cases[i];
    const started = performance.now();
    const outcome = await recommender.recommend({
      requestId: `EVAL-${example.exampleId}`,
      verifiedRequest: example.verifiedRequest,
      justification: example.justification,
    });
    results.push({
      exampleId: example.exampleId,
      scenario: example.scenario,
      justificationKind: example.justificationKind,
      role: example.verifiedRequest.requester.role,
      organization: example.verifiedRequest.requester.organization,
      expected: example.label,
      predicted: outcome.recommendation,
      status: outcome.generationStatus,
      errorCode: outcome.provenance.errorCode || null,
      parserErrors: outcome.provenance.parserErrors || [],
      latencyMs: outcome.provenance.latencyMs.total,
      promptTokens: outcome.provenance.usage?.promptTokens ?? null,
      completionTokens: outcome.provenance.usage?.completionTokens ?? null,
    });
    if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, cases.length);
  }
  return results;
}

/** Descriptive facts about the run, recorded alongside every number. */
function runDescriptor({ label, modelIdentity, url, servedModel, adapterPath, maxTokens, datasetDir }) {
  const { bundle, bundleHash } = loadBundle();
  return {
    label,
    evaluatedAtUtc: new Date().toISOString(),
    model: { ...modelIdentity, servedModel, url, adapterPath: adapterPath || null },
    decoding: { temperature: 0, topP: 1, maxTokens, thinking: 'disabled' },
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    policyBundle: { bundleId: bundle.bundleId, version: bundle.version, bundleHash },
    dataset: path.relative(process.cwd(), datasetDir),
    harness: 'backend/src/dias/recommender.js (the live recommendation path)',
  };
}

module.exports = { DEFAULT_SETS, createEvaluationRecommender, evaluateSet, readCases, runDescriptor };
