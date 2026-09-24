'use strict';

/**
 * Backend architecture guard.
 *
 * DIAS's central constraint is that the model is advisory and nothing corrects
 * it at runtime. That is an architectural property, not a behaviour any single
 * unit test can demonstrate: it holds only while no live code path can reach a
 * deterministic policy evaluator.
 *
 * This suite walks the real `require` graph from the live entry points and fails
 * if a forbidden module is reachable, so the property is checked by construction
 * rather than asserted in prose.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { expect } = require('chai');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The processes that actually run in DIAS mode. */
const ENTRY_POINTS = Object.freeze([
  'backend/src/ai/start.js',        // the recommendation listener
  'backend/src/routes/access.js',   // request submission, auditor, authorizations
  'backend/src/routes/audit.js',    // audit trail
  'backend/src/dias/runtime.js',    // composition root
]);

/**
 * Modules that must never be reachable from a live DIAS path.
 *
 * The reference oracle is a legitimate part of the repository — it labels the
 * training data and validates the dataset offline — which is exactly why its
 * absence from the runtime has to be enforced rather than assumed.
 */
const FORBIDDEN = Object.freeze([
  { file: 'policies/reference-oracle/referencePolicyOracle.js', why: 'the offline reference oracle must never judge a live recommendation' },
  { file: 'chaincode/crimerecords/lib/policy/policyEngine.js', why: 'the SEAL deterministic policy engine must not run in the live path' },
  { file: 'chaincode/crimerecords/lib/policy/controlledDecision.js', why: 'SEAL controlled-decision logic must not run in the live path' },
  { file: 'chaincode/crimerecords/lib/policy/llmDecisionProtocol.js', why: 'the SEAL decision protocol enforced engine/model agreement' },
  { file: 'chaincode/crimerecords/lib/policy/dynamicPolicy.js', why: 'SEAL property-fingerprint dynamic policy is replaced by exact-record authorization' },
  { file: 'backend/src/llm/policyDecision.js', why: 'the SEAL runtime guard overrode the model recommendation' },
  { file: 'backend/src/llm/groundedPolicyPrompt.js', why: 'DIAS has exactly one prompt implementation' },
]);

/**
 * Resolve the transitive require graph of an entry point without executing it.
 * `Module._resolveFilename` is the same resolver `require` uses, so an alias or
 * a computed-looking path that node would follow is followed here too.
 */
function requireGraph(entryRelative) {
  const entry = path.join(REPO_ROOT, entryRelative);
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !file.startsWith(REPO_ROOT) || file.includes('node_modules')) continue;
    seen.add(file);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [, specifier] of source.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
      if (!specifier.startsWith('.')) continue;
      try {
        queue.push(Module._resolveFilename(specifier, { id: file, filename: file, paths: Module._nodeModulePaths(path.dirname(file)) }));
      } catch {
        // A specifier that does not resolve cannot be reached at runtime either.
      }
    }
  }
  return seen;
}

describe('DIAS backend architecture guard', () => {
  const graphs = ENTRY_POINTS.map((entry) => ({ entry, files: requireGraph(entry) }));

  it('resolves a non-trivial graph for every entry point', () => {
    for (const { entry, files } of graphs) {
      expect(files.size, `${entry} resolved almost nothing`).to.be.greaterThan(3);
    }
  });

  for (const { file, why } of FORBIDDEN) {
    it(`does not reach ${file} — ${why}`, () => {
      const absolute = path.join(REPO_ROOT, file);
      const reachedBy = graphs.filter(({ files }) => files.has(absolute)).map(({ entry }) => entry);
      expect(reachedBy, `reachable from: ${reachedBy.join(', ')}`).to.deep.equal([]);
    });
  }

  it('reaches the DIAS recommender from the listener entry point', () => {
    const listener = graphs.find(({ entry }) => entry === 'backend/src/ai/start.js').files;
    for (const required of ['backend/src/dias/recommender.js', 'backend/src/dias/recommendationService.js',
      'backend/src/dias/recommendationPrompt.js', 'backend/src/dias/attestation.js']) {
      expect(listener.has(path.join(REPO_ROOT, required)), `${required} is not reachable`).to.equal(true);
    }
  });

  it('has no SEAL listener left to run', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'backend/src/ai/decisionService.js')),
      'backend/src/ai/decisionService.js still exists and would import the SEAL guard').to.equal(false);
  });

  it('keeps ESCALATE out of the live recommendation vocabulary', () => {
    const { RECOMMENDATIONS, GENERATION_STATUS } =
      require('../../chaincode/crimerecords/lib/dias/recommendationSchema');
    expect([...RECOMMENDATIONS]).to.deep.equal(['ALLOW', 'DENY']);
    expect(Object.values(GENERATION_STATUS)).to.not.include('ESCALATE');
  });
});
