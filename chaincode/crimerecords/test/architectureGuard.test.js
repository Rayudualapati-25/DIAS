'use strict';

/**
 * Architecture guard: the deployed DIAS chaincode contains no policy engine.
 *
 * The retained SEAL-era rule engine and disagreement guard stay in the repository
 * as offline research artifacts only. These tests fail if a contract starts
 * importing them again, if the package stops excluding them, or if runtime code
 * reaches the offline reference oracle.
 */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const LEGACY_ONLY = Object.freeze([
  'lib/policy/policyEngine.js',
  'lib/policy/controlledDecision.js',
  'lib/policy/llmDecisionProtocol.js',
  'lib/policy/dynamicPolicy.js',
  'lib/policy/reasonDecisions.js',
]);
const RELATIVE_REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function resolveModule(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const found = [base, `${base}.js`, path.join(base, 'index.js')]
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error(`cannot resolve ${request} from ${fromFile}`);
  return found;
}

function runtimeGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of fs.readFileSync(file, 'utf8').matchAll(RELATIVE_REQUIRE)) {
      visit(resolveModule(file, match[1]));
    }
  };
  visit(entry);
  return [...seen].map((file) => path.relative(PACKAGE_ROOT, file));
}

describe('architecture guard: the DIAS runtime has no policy engine', () => {
  const graph = runtimeGraph(path.join(PACKAGE_ROOT, 'index.js'));

  it('the deployed contracts never load the retained rule engine or disagreement guard', () => {
    expect(graph.filter((file) => LEGACY_ONLY.includes(file))).to.deep.equal([]);
  });

  it('the chaincode package excludes every retained policy-engine module', () => {
    const script = fs.readFileSync(path.join(REPOSITORY_ROOT, 'network', 'scripts', 'deployCC.sh'), 'utf8');
    for (const file of LEGACY_ONLY) expect(script).to.include(`--exclude /${file}`);
  });

  it('runtime modules stay inside the package and never reach the offline oracle or guard', () => {
    expect(graph.filter((file) => file.startsWith('..'))).to.deep.equal([]);
    for (const file of graph) {
      const source = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
      expect(source, file).to.not.match(
        /reference-oracle|policyEngine|deriveEffectiveClassification|MODEL_POLICY_DISAGREEMENT|MODEL_INPUT_DISAGREEMENT/
      );
    }
  });

  it('loads the DIAS modules for verified requests, authorization, and lifecycle', () => {
    for (const file of [
      'lib/dias/authorization.js', 'lib/dias/lifecycle.js', 'lib/dias/verifiedRequest.js',
    ]) {
      expect(graph).to.include(file);
    }
  });

  it('never loads an LLM recommendation, provenance, or model-registration module', () => {
    expect(graph.filter((file) => /recommendation|provenance|policyContract/i.test(file))).to.deep.equal([]);
  });
});
