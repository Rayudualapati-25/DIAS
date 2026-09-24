'use strict';

/**
 * Write the dataset, its manifest, and the human-review sample.
 *
 * The manifest records the hash of every source the labels depend on — the
 * policy bundle, the oracle, the prompt, the generator modules — and the hash of
 * every artifact written. A dataset whose labels were produced by different
 * source code is then a detectable fact rather than an assumption.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hashFile = (relative) => sha256(fs.readFileSync(path.join(REPO, relative)));

/** Everything a label depends on. A change to any of these invalidates the dataset. */
const LABEL_SOURCES = Object.freeze([
  'policies/dias-governance-policy-v1.json',
  'policies/lib/bundle.js',
  'policies/reference-oracle/referencePolicyOracle.js',
  'backend/src/dias/recommendationPrompt.js',
  'backend/src/dias/policyContextProvider.js',
  'chaincode/crimerecords/lib/dias/verifiedRequest.js',
  'chaincode/crimerecords/lib/dias/recommendationSchema.js',
  'experiments/dias-finetuning/v2/generate.js',
  'experiments/dias-finetuning/v2/lib/example.js',
  'experiments/dias-finetuning/v2/lib/justifications.js',
  'experiments/dias-finetuning/v2/lib/scenarios.js',
  'experiments/dias-finetuning/v2/lib/world.js',
  'experiments/dias-finetuning/v2/lib/plan.js',
  'experiments/dias-finetuning/v2/lib/families.js',
  'experiments/dias-finetuning/v2/lib/identifiers.js',
  'experiments/dias-finetuning/v2/lib/rng.js',
  'experiments/dias-finetuning/v2/lib/assemble.js',
]);

/** Training lines carry only `messages`; the audit copy carries everything. */
const toTrainingLine = (example) => JSON.stringify({ messages: example.messages });
const toCaseLine = (example) => JSON.stringify(example.meta);

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  return { file: path.basename(file), lines: lines.length, sha256: hashFile(path.relative(REPO, file)) };
}

/**
 * A stratified sample for a person to check, one row per line.
 *
 * It is written as `review_status = pending_manual_review` and must stay that
 * way until somebody actually fills it in. Nothing in the repository may claim
 * the dataset was human-reviewed on the strength of this file existing.
 */
function writeReviewSample(file, examples, rng, perStratum) {
  const strata = new Map();
  for (const example of examples) {
    const key = `${example.meta.scenario}|${example.meta.label.reason_code}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(example);
  }
  const rows = [...strata.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, items]) => rng.shuffle(items).slice(0, perStratum));
  const escape = (value) => `"${String(value).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const header = [
    'example_id', 'split', 'scenario', 'justification_family', 'recommendation',
    'reason_code', 'policy_refs', 'review_flags', 'reason', 'justification',
    'verified_request', 'review_status', 'reviewer', 'reviewer_verdict', 'reviewer_note',
  ];
  const lines = [header.join(',')];
  for (const example of rows) {
    const m = example.meta;
    lines.push([
      m.exampleId, m.split, m.scenario, m.justificationFamily, m.label.recommendation,
      m.label.reason_code, m.label.policy_refs.join(' '), m.label.review_flags.join(' '),
      m.label.reason, m.justification, JSON.stringify(m.verifiedRequest),
      'pending_manual_review', '', '', '',
    ].map(escape).join(','));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { file: path.basename(file), rows: rows.length, strata: strata.size };
}

function labelSourceHashes() {
  return Object.fromEntries(LABEL_SOURCES.map((relative) => [relative, hashFile(relative)]));
}

module.exports = {
  LABEL_SOURCES,
  hashFile,
  labelSourceHashes,
  sha256,
  toCaseLine,
  toTrainingLine,
  writeJsonl,
  writeReviewSample,
};
