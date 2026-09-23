#!/usr/bin/env node
'use strict';

/**
 * Validate the written DIAS v2 dataset.
 *
 * Reads the JSONL files from disk and re-derives every property from them. It
 * never imports the generator's in-memory state, so a generator that silently
 * failed to write what it intended produces a validation failure here.
 *
 *   node experiments/dias-finetuning/v2/validate.js [--dir <dataset>] [--json <report>]
 *
 * Exit code 1 when any check fails.
 */

const fs = require('fs');
const path = require('path');

const { loadBundle } = require('../../../policies/lib/bundle');
const { HELD_OUT_FAMILIES } = require('./lib/justifications');
const checks = require('./lib/checks');

const DEFAULT_DIR = path.resolve(__dirname, '..', 'data-v2-binary');
const BALANCED_SETS = Object.freeze([
  'train', 'validation-balanced', 'test-decision-balanced', 'test-ood-paraphrase',
]);
const BALANCE_TOLERANCE = 0.02;
const INDEPENDENCE_TOLERANCE = 0.08;
const PREFIX_TEST = Object.freeze({ minBucket: 50, sigma: 4 });

const SET_NAMES = Object.freeze([
  'train', 'validation-balanced', 'test-decision-balanced', 'test-reason-balanced',
  'test-adversarial', 'test-ood-paraphrase', 'test-multi-rule', 'workflow-evaluation',
]);

function readCases(dir, name) {
  const file = path.join(dir, `${name}.cases.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The training JSONL and the audit copy must describe the same examples. */
function checkTrainingFilesAgree(dir, name, cases) {
  const file = path.join(dir, `${name}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length !== cases.length) {
    return { id: `pairing:${name}`, ok: false, detail: `${lines.length} training lines vs ${cases.length} cases` };
  }
  for (let i = 0; i < lines.length; i += 1) {
    const record = JSON.parse(lines[i]);
    const assistant = record.messages[record.messages.length - 1];
    if (assistant.role !== 'assistant') {
      return { id: `pairing:${name}`, ok: false, detail: `line ${i + 1} has no assistant turn` };
    }
    if (JSON.stringify(JSON.parse(assistant.content)) !== JSON.stringify(cases[i].label)) {
      return { id: `pairing:${name}`, ok: false, detail: `line ${i + 1} completion differs from its recorded label` };
    }
  }
  return { id: `pairing:${name}`, ok: true, detail: `${lines.length} training lines match their audit records` };
}

function main() {
  const args = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const dir = args.dir ? path.resolve(args.dir) : DEFAULT_DIR;
  const { bundle, clauseRefs } = loadBundle();
  const policy = {
    clauseRefs,
    reasonCodes: bundle.reasonCodes,
    reviewFlags: Object.keys(bundle.reviewFlags),
  };

  const bySet = Object.fromEntries(SET_NAMES.map((name) => [name, readCases(dir, name)]));
  const all = SET_NAMES.flatMap((name) => bySet[name]);

  const results = [
    ...SET_NAMES.map((name) => checkTrainingFilesAgree(dir, name, bySet[name])),
    checks.checkSchema(all, policy),
    checks.checkLabelReproduction(all, bundle),
    checks.checkBalance(bySet, BALANCE_TOLERANCE, BALANCED_SETS),
    checks.checkDuplicatePrompts(bySet),
    checks.checkFeatureLeakage(bySet),
    checks.checkFamilyLeakage(bySet),
    checks.checkTemplateLeakage(bySet, HELD_OUT_FAMILIES.map((f) => f.id)),
    checks.checkIdentifierLeakage(all),
    checks.checkIdentifierPredictiveness(all, 'recordId', 6, PREFIX_TEST),
    checks.checkIdentifierPredictiveness(all, 'caseId', 6, PREFIX_TEST),
    checks.checkIdentifierPredictiveness(all, 'username', 4, PREFIX_TEST),
    checks.checkCoverage(all, bundle),
    checks.checkVocabularyCoverage(all, bundle),
    checks.checkPrecedence(all, bundle),
    checks.checkExplanationGrounding(all),
    checks.checkIrrelevantFieldIndependence(all, INDEPENDENCE_TOLERANCE),
    checks.checkScenarioPresence(bySet),
  ];

  const failed = results.filter((result) => !result.ok);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id.padEnd(34)} ${result.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), `${JSON.stringify({
      dataset: path.relative(process.cwd(), dir),
      validatedAtUtc: new Date().toISOString(),
      bundleHash: loadBundle().bundleHash,
      totalExamples: all.length,
      setSizes: Object.fromEntries(SET_NAMES.map((n) => [n, bySet[n].length])),
      checks: results,
      passed: results.length - failed.length,
      failed: failed.length,
    }, null, 2)}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

if (require.main === module) main();
module.exports = { BALANCED_SETS, SET_NAMES, checkTrainingFilesAgree, readCases };
