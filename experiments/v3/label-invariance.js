#!/usr/bin/env node
'use strict';

/**
 * Label invariance under the v3 input schema (plan step 5).
 *
 * v3 removes the self-declared emergency flag and the approval flag from the
 * verified context. This check applies the reference policy oracle to every
 * tracked dataset case twice, with the v1 facts and with the v3 facts, and counts
 * any difference in recommendation, reason code, policy references or review
 * flags. It also checks the oracle still reproduces the stored label.
 *
 *   node experiments/v3/label-invariance.js --out experiments/runs/<date>_v3_label_invariance
 *
 * Offline and deterministic: no model, no network, no ledger.
 */

const fs = require('fs');
const path = require('path');
const { loadBundle } = require('../../policies/lib/bundle');
const { evaluateReference } = require('../../policies/reference-oracle/referencePolicyOracle');
const { v3InputsFor } = require('../dias-finetuning/v2/eval/runner');

const DATASET = path.resolve(__dirname, '..', 'dias-finetuning', 'data-v2-binary');

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const verdictOf = (bundle, facts) => {
  const verdict = evaluateReference(bundle, facts);
  return {
    recommendation: verdict.recommendation,
    reason_code: verdict.reason_code,
    policy_refs: verdict.policy_refs,
    review_flags: verdict.review_flags,
  };
};

function main() {
  const outDir = path.resolve(argument('out', path.join('experiments', 'runs', 'v3_label_invariance')));
  const { bundle, bundleHash } = loadBundle();
  const files = fs.readdirSync(DATASET).filter((name) => name.endsWith('.cases.jsonl')).sort();
  const perSet = {};
  const differences = [];
  for (const file of files) {
    const cases = fs.readFileSync(path.join(DATASET, file), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const counts = {
      cases: cases.length, identical: 0, changed: 0, labelReproduced: 0,
      emergencyFlagTrue: 0, approvalTokenTrue: 0,
    };
    for (const example of cases) {
      const before = verdictOf(bundle, example.verifiedRequest);
      const after = verdictOf(bundle, v3InputsFor(example).verifiedRequest);
      if (JSON.stringify(before) === JSON.stringify(after)) counts.identical += 1;
      else {
        counts.changed += 1;
        differences.push({ file, exampleId: example.exampleId, before, after });
      }
      if (example.label && example.label.recommendation === after.recommendation
          && example.label.reason_code === after.reason_code
          && JSON.stringify(example.label.policy_refs) === JSON.stringify(after.policy_refs)) {
        counts.labelReproduced += 1;
      }
      if (example.verifiedRequest.request.emergencyFlag === true) counts.emergencyFlagTrue += 1;
      if (example.verifiedRequest.request.approvalTokenPresent === true) counts.approvalTokenTrue += 1;
    }
    perSet[file.replace('.cases.jsonl', '')] = counts;
  }
  const totals = Object.values(perSet).reduce((sum, counts) => {
    for (const [key, value] of Object.entries(counts)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {});
  const result = {
    experiment: 'v3-label-invariance',
    kind: 'offline deterministic check (reference oracle; no model, no ledger)',
    policy: { bundleId: bundle.bundleId, version: bundle.version, bundleHash },
    question: 'Does removing emergencyFlag and approvalTokenPresent from the verified facts change any policy label?',
    perSet,
    totals,
    differences,
    node: process.version,
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'label-invariance.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(totals)}\n`);
  if (differences.length > 0) process.exitCode = 1;
}

main();
