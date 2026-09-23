#!/usr/bin/env node
'use strict';

/**
 * DIAS completion checklist, computed rather than asserted.
 *
 * Every item is decided by inspecting an artifact on disk: a passing test run, a
 * metrics file, a hash, a committed transaction record. Nothing here is a claim
 * a person typed in. An item with no evidence is NOT READY — not "probably
 * fine" — because a checklist that can only say yes is decoration.
 *
 *   node scripts/dias/readiness.js [--json <file>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const V6_SHA = '5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe';
// The V6 adapter lives in the sibling crime-records-network checkout; its bytes are
// never in this repository. Override the location with DIAS_V6_ADAPTER_PATH.
const V6_ADAPTER = process.env.DIAS_V6_ADAPTER_PATH || path.resolve(REPO, '..', 'crime-records-network',
  'LLMxAI/experiments/llm_policy_engine/adapters/qwen3-14b-seba-lora-v6-best/adapters.safetensors');

const exists = (rel) => fs.existsSync(path.join(REPO, rel));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const sh = (cmd) => {
  try {
    return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const check = (id, requirement, ok, evidence) => ({
  id, requirement, status: ok ? 'READY' : 'NOT READY', evidence: String(evidence),
});

/** A test suite counts only if it was actually run and reported passing. */
function suite(id, requirement, command, cwd) {
  try {
    const output = execSync(command, {
      cwd: path.join(REPO, cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const mocha = output.match(/(\d+) passing/);
    const nodeTest = output.match(/^# pass (\d+)$/m);
    const failing = output.match(/(\d+) failing/);
    const nodeFail = output.match(/^# fail (\d+)$/m);
    const passed = Number((mocha || nodeTest || [])[1] || 0);
    const failed = Number((failing || nodeFail || [])[1] || 0);
    return check(id, requirement, passed > 0 && failed === 0, `${passed} passing, ${failed} failing`);
  } catch (error) {
    return check(id, requirement, false, `suite did not complete: ${String(error.message).slice(0, 120)}`);
  }
}

function architectureChecks() {
  const items = [];
  items.push(check('arch.binary-vocabulary',
    'the model vocabulary is exactly ALLOW and DENY',
    (() => {
      const { RECOMMENDATIONS, GENERATION_STATUS } =
        require(path.join(REPO, 'chaincode/crimerecords/lib/dias/recommendationSchema'));
      return [...RECOMMENDATIONS].join() === 'ALLOW,DENY'
        && !Object.values(GENERATION_STATUS).includes('ESCALATE');
    })(),
    'recommendationSchema.RECOMMENDATIONS'));

  items.push(check('arch.no-seal-listener',
    'the SEAL listener that imported the runtime guard is gone',
    !exists('backend/src/ai/decisionService.js'),
    'backend/src/ai/decisionService.js absent'));

  items.push(check('arch.exact-scope',
    'dynamic authorization scope is exact-record',
    (() => {
      const { SCOPE_VERSION } = require(path.join(REPO, 'chaincode/crimerecords/lib/dias/authorization'));
      return SCOPE_VERSION === 'dias-authorization-scope-exact-record-v1';
    })(),
    'authorization.SCOPE_VERSION'));

  items.push(check('arch.action-purpose-supplied',
    'action and purpose are supplied to the model as verified facts',
    (() => {
      const { VERIFIED_REQUEST_FIELDS } =
        require(path.join(REPO, 'chaincode/crimerecords/lib/dias/verifiedRequest'));
      return VERIFIED_REQUEST_FIELDS.request.includes('action')
        && VERIFIED_REQUEST_FIELDS.request.includes('purpose');
    })(),
    'verifiedRequest.VERIFIED_REQUEST_FIELDS.request'));
  return items;
}

function policyChecks() {
  const items = [];
  const bundleOk = exists('policies/dias-governance-policy-v1.json');
  let hash = '';
  if (bundleOk) {
    const { loadBundle } = require(path.join(REPO, 'policies/lib/bundle'));
    hash = loadBundle().bundleHash;
  }
  items.push(check('policy.bundle', 'a versioned governance policy bundle exists with a canonical hash',
    bundleOk && /^[0-9a-f]{64}$/.test(hash), hash || 'missing'));
  items.push(check('policy.open-questions',
    'the open-questions document referenced by the bundle exists and names this bundle',
    exists('docs/policies/policy-open-questions.md')
    && fs.readFileSync(path.join(REPO, 'docs/policies/policy-open-questions.md'), 'utf8').includes(hash),
    'docs/policies/policy-open-questions.md'));
  items.push(check('policy.specification',
    'the generated specification matches the bundle',
    exists('docs/policies/governance-policy-specification.md')
    && fs.readFileSync(path.join(REPO, 'docs/policies/governance-policy-specification.md'), 'utf8').includes(hash),
    'docs/policies/governance-policy-specification.md'));
  return items;
}

function datasetChecks() {
  const items = [];
  const manifestPath = 'experiments/dias-finetuning/data-v2-binary/manifest.json';
  const validationPath = 'experiments/runs/20260912_dias_v7_dataset/validation.json';
  items.push(check('data.exists', 'the binary v2 dataset exists with a manifest',
    exists(manifestPath), manifestPath));
  if (exists(validationPath)) {
    const v = readJson(validationPath);
    items.push(check('data.validated', 'every dataset check passes',
      v.failed === 0 && v.passed > 0, `${v.passed}/${v.passed + v.failed} checks`));
  } else {
    items.push(check('data.validated', 'every dataset check passes', false, 'no validation report'));
  }
  if (exists(manifestPath)) {
    const m = readJson(manifestPath);
    items.push(check('data.not-claimed-reviewed',
      'the dataset is NOT described as human-reviewed',
      m.humanReview.reviewStatus === 'pending_manual_review',
      `humanReview.reviewStatus = ${m.humanReview.reviewStatus}`));
    items.push(check('data.labels-from-policy',
      'labels come from the written policy, never from auditor overrides',
      m.labelSource.auditorOverridesUsedAsLabels === false,
      m.labelSource.method));
  }
  const tokens = 'experiments/runs/20260912_dias_v7_dataset/token_lengths.json';
  if (exists(tokens)) {
    const t = readJson(tokens);
    items.push(check('data.token-audit',
      'max_seq_length is justified by a tokenizer measurement',
      t.overallMaxTokens > 0 && t.recommendedMaxSeqLength >= t.overallMaxTokens,
      `longest ${t.overallMaxTokens} tokens, recommended ${t.recommendedMaxSeqLength}`));
  } else {
    items.push(check('data.token-audit', 'max_seq_length is justified by a tokenizer measurement',
      false, 'no token audit'));
  }
  return items;
}

/** The newest live acceptance run of the backend-LLM design (make dias-acceptance). */
function latestAcceptanceRun() {
  const runs = path.join(REPO, 'experiments', 'runs');
  return fs.readdirSync(runs)
    .filter((name) => /_dias_backend_llm_acceptance/.test(name))
    .map((name) => path.join('experiments', 'runs', name, 'acceptance.json'))
    .filter((file) => exists(file))
    .map((file) => ({ file, report: readJson(file) }))
    .sort((a, b) => String(a.report.startedAtUtc).localeCompare(String(b.report.startedAtUtc)))
    .pop() || null;
}

function liveChecks() {
  const latest = latestAcceptanceRun();
  if (!latest) {
    return [check('live.scenarios', 'live acceptance scenarios pass', false, 'no acceptance run')];
  }
  const { file, report } = latest;
  const required = Array.from({ length: 14 }, (_, index) => `R${index + 1}`);
  const byId = new Map(report.scenarios.map((item) => [item.id, item]));
  return [
    check('live.scenarios', 'every live acceptance scenario passes in the newest run',
      report.summary.fail === 0 && report.summary.notExercised === 0
        && report.summary.pass === report.summary.total,
      `${report.summary.pass}/${report.summary.total} scenarios, `
        + `${report.checks.passed}/${report.checks.total} checks (${path.dirname(file)})`),
    check('live.coverage', 'scenarios R1-R14 were all exercised',
      required.every((id) => byId.has(id) && byId.get(id).status === 'PASS'),
      `ran ${required.filter((id) => byId.has(id)).length} of ${required.length}`),
  ];
}

function modelChecks() {
  const items = [];
  const v6Actual = fs.existsSync(V6_ADAPTER)
    ? crypto.createHash('sha256').update(fs.readFileSync(V6_ADAPTER)).digest('hex') : 'missing';
  items.push(check('model.v6-intact', 'the V6 adapter is byte-identical to its recorded digest',
    v6Actual === V6_SHA, v6Actual));

  const baseline = 'experiments/runs/20260912_dias_qwen3_baseline/metrics.json';
  if (exists(baseline)) {
    const b = readJson(baseline);
    const sets = Object.keys(b.sets || {});
    items.push(check('model.baseline',
      'an untuned baseline exists on every held-out set',
      sets.length >= 6, `${sets.length} sets: ${sets.join(', ')}`));
  } else {
    items.push(check('model.baseline', 'an untuned baseline exists on every held-out set',
      false, 'no baseline metrics'));
  }

  const smoke = 'experiments/runs/20260912_dias_qwen3_lora_smoke_v7/metrics.json';
  if (exists(smoke)) {
    const s = readJson(smoke);
    items.push(check('model.smoke', 'the training smoke run passed its engineering checks',
      s.status === 'passed' && s.freshBase && !s.resumeAdapterUsed && s.checkpointSaved,
      `fresh base ${s.freshBase}, checkpoint ${s.checkpointSaved}, peak ${s.peakMemoryGb} GB`));
  } else {
    items.push(check('model.smoke', 'the training smoke run passed its engineering checks',
      false, 'no smoke metrics'));
  }

  const inference = 'experiments/runs/20260912_dias_qwen3_lora_smoke_v7/checkpoint_inference.json';
  if (exists(inference)) {
    const i = readJson(inference);
    items.push(check('model.checkpoint-loads',
      'a saved checkpoint loads and emits parseable binary output',
      i.allParsed && i.allBinary && i.allKeysExact,
      `${i.prompts} prompts, all parsed ${i.allParsed}, all binary ${i.allBinary}`));
  } else {
    items.push(check('model.checkpoint-loads',
      'a saved checkpoint loads and emits parseable binary output', false, 'not verified'));
  }

  // V7 itself: present only when a full run and its evaluation exist.
  const v7Run = fs.readdirSync(path.join(REPO, 'experiments', 'runs'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((d) => /dias_qwen3_lora_v7/.test(d) && !/smoke/.test(d));
  items.push(check('model.v7-trained', 'a full V7 adapter exists with a complete run record',
    v7Run.some((d) => exists(`experiments/runs/${d}/run.json`)
      && readJson(`experiments/runs/${d}/run.json`).status === 'completed'),
    v7Run.length ? v7Run.join(', ') : 'no full V7 run'));
  items.push(check('model.v7-evaluated', 'V7 has been evaluated on the held-out suite',
    v7Run.some((d) => exists(`experiments/runs/${d}/metrics.json`)),
    v7Run.length ? v7Run.join(', ') : 'no V7 evaluation'));
  return items;
}

function repositoryChecks() {
  const items = [];
  items.push(check('repo.integrity', 'the publication check finds no secrets or local state',
    /passed/.test(sh('python3 scripts/check-repository.py')),
    sh('python3 scripts/check-repository.py').split('\n').pop() || 'check failed'));
  const dirty = sh('git status --porcelain').split('\n').filter(Boolean);
  items.push(check('repo.clean', 'the working tree has no unexplained changes',
    dirty.length === 0, dirty.length === 0 ? 'clean' : `${dirty.length} uncommitted entries`));
  items.push(check('repo.branch', 'work is on its own branch',
    sh('git branch --show-current') !== 'main', `branch ${sh('git branch --show-current')}`));
  return items;
}

function main() {
  const args = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const groups = {
    architecture: architectureChecks(),
    policy: policyChecks(),
    dataset: datasetChecks(),
    liveFabric: liveChecks(),
    model: modelChecks(),
    tests: [
      suite('tests.chaincode', 'chaincode suite passes', 'npm test', 'chaincode/crimerecords'),
      suite('tests.backend', 'backend suite passes',
        "npx mocha --require test/setup.unit.js 'test/**/*.unit.test.js' --timeout 20000", 'backend'),
      suite('tests.policies', 'policy suite passes', 'npm test', 'policies'),
      suite('tests.frontend', 'frontend suite passes', 'npm test', 'frontend'),
      suite('tests.dataset', 'dataset and evaluation suite passes', 'npm test',
        'experiments/dias-finetuning/v2'),
    ],
    repository: repositoryChecks(),
  };

  const all = Object.values(groups).flat();
  const ready = all.filter((c) => c.status === 'READY').length;
  const verdict = ready === all.length ? 'COMPLETE' : 'NOT COMPLETE';

  for (const [group, items] of Object.entries(groups)) {
    console.log(`\n${group}`);
    for (const item of items) {
      console.log(`  ${item.status === 'READY' ? 'READY    ' : 'NOT READY'} ${item.id.padEnd(28)} ${item.evidence}`);
    }
  }
  console.log(`\n${ready}/${all.length} checks ready — ${verdict}`);
  const blocking = all.filter((c) => c.status !== 'READY');
  if (blocking.length > 0) {
    console.log('\nblocking:');
    for (const item of blocking) console.log(`  ${item.id}: ${item.requirement} (${item.evidence})`);
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), `${JSON.stringify({
      artifactType: 'dias-completion-checklist',
      generatedAtUtc: new Date().toISOString(),
      commit: sh('git rev-parse HEAD'),
      branch: sh('git branch --show-current'),
      verdict,
      ready,
      total: all.length,
      groups,
    }, null, 2)}\n`);
  }
  process.exit(blocking.length === 0 ? 0 : 1);
}

if (require.main === module) main();
