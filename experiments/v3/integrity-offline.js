#!/usr/bin/env node
'use strict';

/**
 * Plan step 17, offline part: integrity cost and behaviour of DIAS v3.
 *
 *   1. latency     hashing, canonicalization, signing and encryption (microbenchmarks);
 *   2. workflows   contract execution time and ledger write set per transaction,
 *                  v2 (baseline commit) against v3, on the in-process mock Fabric stub;
 *                  plus one v3 end-to-end path through the real backend runtime
 *                  (worker, signer, encrypted review store) with a stand-in model;
 *   3. tamper      which changes to the off-chain objects and to κ are detected,
 *                  and by which check (ablation: digest only, field binding only,
 *                  signature, and a naive non-canonical hash);
 *   4. policy      what a policy change invalidates (reuse, pending decisions,
 *                  κ commits, document release), v3 against the v2 baseline;
 *   5. storage     bytes written per workflow, on-chain and off-chain.
 *
 * Every number comes from the mock Fabric stub (test/testHelpers.js) or from
 * single-process microbenchmarks. No endorsement, ordering, block commit, gossip
 * or disk-backed state database is involved. These are NOT live Fabric results.
 *
 * Usage (from the repository root, after `npm ci` in chaincode/crimerecords and backend):
 *   node experiments/v3/integrity-offline.js --out experiments/runs/<date>_v3_integrity_offline \
 *     [--seed 20261009] [--iterations 5000] [--workflows 200] [--cases 200] [--quick]
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CC = path.join(ROOT, 'chaincode', 'crimerecords');
const BACKEND = path.join(ROOT, 'backend');
const BASELINE_COMMIT = '2336bb4724a088490614ce86d496ef9b03c31265'; // tag eval-baseline-2026-10-01

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { seed: 20261009, iterations: 5000, warmup: 500, workflows: 200, cases: 200, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--quick') Object.assign(args, { iterations: 300, warmup: 50, workflows: 10, cases: 10 });
    else if (flag === '--out') args.out = argv[++i];
    else if (['--seed', '--iterations', '--warmup', '--workflows', '--cases'].includes(flag)) {
      args[flag.slice(2)] = Number(argv[++i]);
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.out) throw new Error('--out <directory> is required');
  return args;
}

// ---------------------------------------------------------------- determinism

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An Ed25519 key derived from the seed, so signatures are reproducible. */
function seededEd25519(seed, label) {
  const raw = crypto.createHash('sha256').update(`${label}:${seed}`).digest();
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return { privateKey, publicKeyPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
}

const WORDS = ('case record officer station district review evidence custody inquiry witness statement '
  + 'report forensic sample timeline assignment hearing follow-up verification request supervisor '
  + 'complaint vehicle property seizure analysis summary update cross-check pending lead').split(' ');

/** Synthetic text only; no real names or case details. */
function syntheticText(rand, minWords, maxWords) {
  const count = minWords + Math.floor(rand() * (maxWords - minWords + 1));
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(WORDS[Math.floor(rand() * WORDS.length)]);
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

// ---------------------------------------------------------------- statistics

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  return {
    n: sorted.length, min: sorted[0], p50: pick(0.5), p95: pick(0.95), p99: pick(0.99),
    max: sorted[sorted.length - 1], mean,
  };
}

const round = (value, digits = 3) => (value === undefined || value === null ? value
  : Number(value.toFixed(digits)));
const roundStats = (stats) => Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, k === 'n' ? v : round(v)]));

function timeMicros(fn, { iterations, warmup }) {
  for (let i = 0; i < warmup; i += 1) fn(i);
  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn(i);
    samples[i] = Number(process.hrtime.bigint() - start) / 1000;
  }
  return roundStats(summarize(samples));
}

// ---------------------------------------------------------------- worlds

function loadV3() {
  return {
    world: require(path.join(CC, 'test', 'diasTestWorld.js')),
    helpers: require(path.join(CC, 'test', 'testHelpers.js')),
  };
}

/** Extract the evaluated v2 contract (baseline commit) read-only into `dir`. */
function loadV2(dir) {
  const target = path.join(dir, 'chaincode', 'crimerecords');
  if (!fs.existsSync(path.join(target, 'lib'))) {
    fs.mkdirSync(dir, { recursive: true });
    const archive = execFileSync('git', ['-C', ROOT, 'archive', BASELINE_COMMIT,
      'chaincode/crimerecords/lib', 'chaincode/crimerecords/test/diasTestWorld.js',
      'chaincode/crimerecords/test/testHelpers.js'], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    fs.symlinkSync(path.join(CC, 'node_modules'), path.join(target, 'node_modules'), 'dir');
  }
  return {
    world: require(path.join(target, 'test', 'diasTestWorld.js')),
    helpers: require(path.join(target, 'test', 'testHelpers.js')),
  };
}

/**
 * Run one contract transaction through the world and measure it: execution time
 * of the contract function alone (the stub's ledger copy is outside the timer),
 * and the write set it produced (keys whose value changed, with their sizes).
 */
async function measured(world, caller, prefix, fn) {
  let elapsedMs = 0;
  let writes = [];
  let events = [];
  const { result } = await world.run(caller, world.nextTx(prefix), async (ctx) => {
    const before = new Map(ctx._state);
    const start = process.hrtime.bigint();
    const raw = await fn(ctx);
    elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    writes = [...ctx._state.entries()]
      .filter(([key, value]) => before.get(key) !== value)
      .map(([key, value]) => ({ type: key.split('\u0000')[1], keyBytes: Buffer.byteLength(key), valueBytes: Buffer.byteLength(value) }));
    events = (ctx._events || []).map((event) => ({ name: event.name, bytes: Buffer.byteLength(event.payload) }));
    return raw;
  });
  return { result, elapsedMs, writes, events };
}

const writeBytes = (writes) => writes.reduce((sum, item) => sum + item.keyBytes + item.valueBytes, 0);

// ---------------------------------------------------------------- 1. latency

function runLatency(args, log) {
  const { hashCanonical, hashText, canonicalJson } = require(path.join(CC, 'lib', 'dias', 'commitments.js'));
  const { provenanceMessage, provenancePayload, verifyProvenance } = require(path.join(CC, 'lib', 'dias', 'recommendationCommitment.js'));
  const { verifiedRequestHash } = require(path.join(CC, 'lib', 'dias', 'verifiedRequest.js'));
  const { buildRecommendationObject, recommendationHashOf } = require(path.join(BACKEND, 'src', 'dias', 'recommendationObject.js'));
  const { checkRecommendationIntegrity } = require(path.join(BACKEND, 'src', 'dias', 'recommendationIntegrity.js'));
  const { createReviewCipher } = require(path.join(BACKEND, 'src', 'dias', 'reviewCipher.js'));
  const { verifiedRequestFixture } = require(path.join(BACKEND, 'test', 'fixtures', 'diasFixtures.js'));
  const { commitmentPair, MODEL } = require(path.join(BACKEND, 'test', 'fixtures', 'decisionFixtures.js'));

  const rand = mulberry32(args.seed);
  const justification = syntheticText(rand, 25, 35);
  const note = syntheticText(rand, 50, 70);
  const context = verifiedRequestFixture();
  const pair = commitmentPair('REQ-LAT-1', 'DENY');
  const object = buildRecommendationObject({
    requestId: 'REQ-LAT-1',
    result: { generationStatus: 'OK', recommendation: { recommendation: 'DENY', reason_code: 'CROSS_JURISDICTION', reason: syntheticText(rand, 30, 40), policy_refs: ['GP-JURIS:C1@v1'], missing_evidence: [], review_flags: [] }, provenance: {} },
    binding: pair.commitment, model: MODEL,
  });
  const commitment = { ...pair.commitment, recommendationHash: recommendationHashOf(object) };
  const { privateKey, publicKeyPem } = seededEd25519(args.seed, 'latency-signer');
  const payload = provenancePayload({ channel: 'diaschannel', ...commitment, signerKeyId: 'a'.repeat(64) });
  const signature = crypto.sign(null, provenanceMessage(payload), privateKey).toString('base64');
  const cipher = createReviewCipher({ keyId: 'bench', key: crypto.createHash('sha256').update(`key:${args.seed}`).digest() });
  const entry = { requestId: 'REQ-LAT-1', justification, verifiedRequest: context, recommendationObject: object, auditorNote: { reason: note } };
  const sealed = cipher.seal('REQ-LAT-1', entry);
  const opts = { iterations: args.iterations, warmup: args.warmup };

  const operations = [
    ['h_J: hashText(justification)', () => hashText('justification', justification), Buffer.byteLength(justification)],
    ['h_N: hashText(note)', () => hashText('note', note), Buffer.byteLength(note)],
    ['canonicalJson(verified context)', () => canonicalJson(context), Buffer.byteLength(canonicalJson(context))],
    ['h_C: verifiedRequestHash(context)', () => verifiedRequestHash(context), Buffer.byteLength(canonicalJson(context))],
    ['h_M: recommendationHashOf(M)', () => recommendationHashOf(object), Buffer.byteLength(canonicalJson(object))],
    ['generic hashCanonical(M)', () => hashCanonical('recommendation', object), Buffer.byteLength(canonicalJson(object))],
    ['naive SHA-256(JSON.stringify(M)) [ablation]', () => crypto.createHash('sha256').update(JSON.stringify(object)).digest('hex'), Buffer.byteLength(JSON.stringify(object))],
    ['Ed25519 sign κ provenance', () => crypto.sign(null, provenanceMessage(payload), privateKey), Buffer.byteLength(canonicalJson(payload))],
    ['Ed25519 verify κ provenance', () => verifyProvenance({ publicKeyPem, payload, signature }), Buffer.byteLength(canonicalJson(payload))],
    ['check M against κ (backend)', () => checkRecommendationIntegrity({ commitment, recommendationObject: object }), null],
    ['AES-256-GCM seal review entry', () => cipher.seal('REQ-LAT-1', entry), Buffer.byteLength(JSON.stringify(entry))],
    ['AES-256-GCM open review entry', () => cipher.open('REQ-LAT-1', sealed), Buffer.byteLength(JSON.stringify(entry))],
  ];
  const results = operations.map(([operation, fn, inputBytes]) => {
    const stats = timeMicros(fn, opts);
    log(`latency ${operation}: p50 ${stats.p50} us, p95 ${stats.p95} us`);
    return { operation, inputBytes, unit: 'microseconds', ...stats };
  });
  if (checkRecommendationIntegrity({ commitment, recommendationObject: object }).status !== 'verified') {
    throw new Error('latency fixture does not verify; the benchmark would time the failure path');
  }
  return results;
}

// ---------------------------------------------------------------- 2 and 5. workflows and storage

const WORKFLOWS = Object.freeze([
  { id: 'W1', label: 'reviewed: LLM DENY, auditor FORCE_ALLOW (creates an authorization)', recommendation: 'DENY', decision: 'FORCE_ALLOW' },
  { id: 'W2', label: 'reviewed: LLM DENY, auditor FORCE_DENY (agreed, no authorization)', recommendation: 'DENY', decision: 'FORCE_DENY' },
  { id: 'W3', label: 'reviewed: LLM ALLOW, auditor FORCE_ALLOW (agreed, no authorization)', recommendation: 'ALLOW', decision: 'FORCE_ALLOW' },
  { id: 'W4', label: 'reuse of the authorization created by W1 (no auditor, no LLM)', recommendation: null, decision: null },
]);

async function v2Workflow(v2, workflow) {
  const { CALLERS } = v2.helpers;
  const world = await v2.world.createDiasWorld().seed();
  const tx = [];
  const submit = (prefix) => measured(world, CALLERS.inspector, prefix, (ctx) => world.contracts.access.CreateAccessRequest(
    ctx, 'FIR-1', JSON.stringify({ action: 'view', purpose: 'investigation' })));
  const decide = (requestId, decision, recommendation) => measured(world, CALLERS.auditor, 'AUDIT',
    (ctx) => world.contracts.access.SubmitAuditorDecision(ctx, requestId, decision, recommendation, ''));
  if (workflow.id === 'W4') {
    const first = await submit('SUBMIT');
    await decide(first.result.requestId, 'FORCE_ALLOW', 'DENY');
    const reuse = await submit('REUSE');
    if (reuse.result.processingPath !== 'dynamic-authorization') throw new Error('v2 W4 did not reuse');
    tx.push({ name: 'CreateAccessRequest (reuse)', ...reuse });
    return tx;
  }
  const request = await submit('SUBMIT');
  tx.push({ name: 'CreateAccessRequest', ...request });
  const decision = await decide(request.result.requestId, workflow.decision, workflow.recommendation);
  tx.push({ name: 'SubmitAuditorDecision', ...decision });
  return tx;
}

async function v3Workflow(v3, workflow, justification, note) {
  const { CALLERS } = v3.helpers;
  const { hashText } = require(path.join(CC, 'lib', 'dias', 'commitments.js'));
  const world = await v3.world.createDiasWorld().seed();
  const tx = [];
  const submit = (prefix) => measured(world, CALLERS.inspector, prefix, (ctx) => world.contracts.access.CreateAccessRequest(
    ctx, 'FIR-1', JSON.stringify({ action: 'view', purpose: 'investigation', justificationHash: hashText('justification', justification) })));
  const commit = (requestId, recommendation) => {
    const input = world.commitmentFor(requestId, { recommendation });
    return measured(world, CALLERS.constable, 'KAPPA', (ctx) => world.contracts.access.CommitRecommendation(ctx, requestId, JSON.stringify(input)));
  };
  const decide = (requestId, decision, recommendation) => {
    const agreed = (recommendation === 'ALLOW') === (decision === 'FORCE_ALLOW');
    const noteHash = agreed ? '' : hashText('note', note);
    return measured(world, CALLERS.auditor, 'AUDIT',
      (ctx) => world.contracts.access.SubmitAuditorDecision(ctx, requestId, decision, noteHash, ''));
  };
  if (workflow.id === 'W4') {
    const first = await submit('SUBMIT');
    await commit(first.result.requestId, 'DENY');
    await decide(first.result.requestId, 'FORCE_ALLOW', 'DENY');
    const reuse = await submit('REUSE');
    if (reuse.result.processingPath !== 'dynamic-authorization') throw new Error('v3 W4 did not reuse');
    tx.push({ name: 'CreateAccessRequest (reuse)', ...reuse });
    return tx;
  }
  const request = await submit('SUBMIT');
  tx.push({ name: 'CreateAccessRequest', ...request });
  tx.push({ name: 'CommitRecommendation', ...(await commit(request.result.requestId, workflow.recommendation)) });
  tx.push({ name: 'SubmitAuditorDecision', ...(await decide(request.result.requestId, workflow.decision, workflow.recommendation)) });
  return tx;
}

function aggregateWorkflow(version, workflow, runs) {
  const names = runs[0].map((item) => item.name);
  const transactions = names.map((name, index) => {
    const samples = runs.map((run) => run[index]);
    const bytes = samples.map((item) => writeBytes(item.writes));
    const byType = {};
    for (const item of samples[0].writes) byType[item.type] = (byType[item.type] || 0) + item.keyBytes + item.valueBytes;
    return {
      name,
      executionMs: roundStats(summarize(samples.map((item) => item.elapsedMs))),
      keysWritten: samples[0].writes.length,
      writeSetBytes: { min: Math.min(...bytes), max: Math.max(...bytes) },
      writeSetBytesByType: byType,
      eventBytes: samples[0].events.reduce((sum, event) => sum + event.bytes, 0),
    };
  });
  const totals = runs.map((run) => run.reduce((sum, item) => sum + writeBytes(item.writes), 0));
  return {
    version, workflow: workflow.id, label: workflow.label, repetitions: runs.length,
    transactions: transactions.length,
    totalWriteSetBytes: { min: Math.min(...totals), max: Math.max(...totals) },
    totalExecutionMs: roundStats(summarize(runs.map((run) => run.reduce((sum, item) => sum + item.elapsedMs, 0)))),
    perTransaction: transactions,
  };
}

async function runWorkflows(args, v2, v3, log) {
  const rand = mulberry32(args.seed + 1);
  const results = [];
  for (const workflow of WORKFLOWS) {
    const v2Runs = [];
    const v3Runs = [];
    for (let i = 0; i < args.workflows; i += 1) {
      v2Runs.push(await v2Workflow(v2, workflow));
      v3Runs.push(await v3Workflow(v3, workflow, syntheticText(rand, 25, 35), syntheticText(rand, 50, 70)));
    }
    for (const [version, runs] of [['v2', v2Runs], ['v3', v3Runs]]) {
      const summary = aggregateWorkflow(version, workflow, runs);
      results.push(summary);
      log(`workflow ${version} ${workflow.id}: ${summary.transactions} tx, write set ${summary.totalWriteSetBytes.min}-${summary.totalWriteSetBytes.max} B, exec p50 ${summary.totalExecutionMs.p50} ms`);
    }
  }
  return results;
}

// ---------------------------------------------------------------- 2b. end to end through the backend runtime

function startModel(state) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(state.output) } }],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
  })));
}

/** The backend's ledger client, answered by the v3 contracts on the mock stub. */
function stubLedger(world, caller, timings) {
  const contractOf = { AccessContract: 'access', AuditContract: 'audit', GovernanceContract: 'governance' };
  const call = async (contract, fn, args) => {
    const outcome = await measured(world, caller, 'BACKEND', (ctx) => world.contracts[contractOf[contract]][fn](ctx, ...args));
    timings.push({ fn, elapsedMs: outcome.elapsedMs, writeSetBytes: writeBytes(outcome.writes) });
    return outcome.result;
  };
  return {
    submit: (org, user, contract, fn, ...args) => call(contract, fn, args),
    evaluate: (org, user, contract, fn, ...args) => call(contract, fn, args).catch(() => null),
  };
}

async function runEndToEnd(args, v3, scratch, log) {
  const { CALLERS } = v3.helpers;
  const { hashText } = require(path.join(CC, 'lib', 'dias', 'commitments.js'));
  const config = require(path.join(BACKEND, 'src', 'config.js'));
  const { createDiasRuntime } = require(path.join(BACKEND, 'src', 'dias', 'runtime.js'));
  const accessRouter = require(path.join(BACKEND, 'src', 'routes', 'access.js'));
  const { validOutput } = require(path.join(BACKEND, 'test', 'fixtures', 'diasFixtures.js'));
  const silent = { log() {}, error() {} };
  const state = { output: validOutput({ recommendation: 'DENY', reason_code: 'CROSS_JURISDICTION', reason: 'Requester jurisdiction differs from record jurisdiction (GP-JURIS:C1@v1).', policy_refs: ['GP-JURIS:C1@v1'] }) };
  const model = await startModel(state);
  const keyFile = path.join(scratch, 'signing.pem');
  fs.writeFileSync(keyFile, seededEd25519(args.seed, 'backend-signer').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const rand = mulberry32(args.seed + 2);
  const samples = [];
  try {
    for (let i = 0; i < args.workflows; i += 1) {
      const world = await v3.world.createDiasWorld().seed({ registerSigner: false });
      const timings = [];
      const ledger = stubLedger(world, CALLERS.auditor, timings);
      const runtimeFor = (dir, encrypted) => createDiasRuntime({
        settings: {
          ...config, CHANNEL: 'diaschannel', DIAS_MODEL_URL: model.url, DIAS_REVIEW_STORE_DIR: dir,
          DIAS_REVIEW_STORE_KEY: encrypted ? crypto.createHash('sha256').update(`store:${args.seed}`).digest('base64') : '',
          DIAS_REVIEW_STORE_KEY_ID: 'bench', DIAS_RECOMMENDER_SIGNING_KEY_FILE: keyFile,
        },
        ledger, log: silent,
      });
      const runtime = runtimeFor(path.join(scratch, `reviews-${i}`), true);
      await world.registerSigner(runtime.signedRecommender.signer
        ? runtime.signedRecommender.signer.publicKeyPem
        : crypto.createPublicKey(fs.readFileSync(keyFile)).export({ type: 'spki', format: 'pem' }));
      const justification = syntheticText(rand, 25, 35);
      const note = syntheticText(rand, 50, 70);

      const submitted = await measured(world, CALLERS.inspector, 'SUBMIT', (ctx) => world.contracts.access.CreateAccessRequest(
        ctx, 'FIR-1', JSON.stringify({ action: 'view', purpose: 'investigation', justificationHash: hashText('justification', justification) })));
      const request = submitted.result;
      const t0 = process.hrtime.bigint();
      const answer = accessRouter.answerCommittedRequest({ request, justification, runtime: () => runtime, log: silent });
      const tOpen = process.hrtime.bigint();
      await runtime.worker.idle();
      const tCommitted = process.hrtime.bigint();
      const entry = runtime.store.read(request.requestId);
      if (answer.status !== 202 || entry.recommendationState !== 'committed') {
        throw new Error(`end-to-end ${request.requestId}: recommendation state ${entry.recommendationState}`);
      }
      const noteHash = hashText('note', note);
      const tStage = process.hrtime.bigint();
      runtime.store.stageNote(request.requestId, { noteHash, reason: note, decision: 'FORCE_ALLOW', auditorUsername: 'sp.test', recordId: 'FIR-1' });
      const tStaged = process.hrtime.bigint();
      const decided = await measured(world, CALLERS.auditor, 'AUDIT', (ctx) => world.contracts.access.SubmitAuditorDecision(
        ctx, request.requestId, 'FORCE_ALLOW', noteHash, ''));
      const tNote = process.hrtime.bigint();
      runtime.store.commitNote(request.requestId, { noteHash, reason: note, decision: 'FORCE_ALLOW', auditorUsername: 'sp.test' });
      const tDone = process.hrtime.bigint();

      const encryptedBytes = fs.statSync(path.join(scratch, `reviews-${i}`, `${request.requestId}.json`)).size;
      const finalEntry = runtime.store.read(request.requestId);
      const plaintextBytes = Buffer.byteLength(`${JSON.stringify(finalEntry, null, 2)}\n`);
      if (!decided.result.dynamicAuthorization) throw new Error(`end-to-end ${request.requestId}: no authorization created`);
      const ms = (a, b) => Number(b - a) / 1e6;
      const kappa = timings.find((item) => item.fn === 'CommitRecommendation');
      samples.push({
        openReviewMs: ms(t0, tOpen),
        generateSignCommitMs: ms(tOpen, tCommitted),
        commitRecommendationContractMs: kappa ? kappa.elapsedMs : null,
        stageNoteMs: ms(tStage, tStaged),
        commitNoteMs: ms(tNote, tDone),
        createRequestContractMs: submitted.elapsedMs,
        decisionContractMs: decided.elapsedMs,
        onChainWriteSetBytes: writeBytes(submitted.writes) + (kappa ? kappa.writeSetBytes : 0) + writeBytes(decided.writes),
        offChainEncryptedBytes: encryptedBytes,
        offChainPlaintextBytes: plaintextBytes,
      });
    }
  } finally {
    await model.close();
  }
  const fields = Object.keys(samples[0]);
  const summary = Object.fromEntries(fields.map((field) => [field, roundStats(summarize(samples.map((item) => item[field])))]));
  log(`end-to-end v3 (backend runtime, stand-in model): generate+sign+commit p50 ${summary.generateSignCommitMs.p50} ms; off-chain ${summary.offChainEncryptedBytes.p50} B encrypted vs ${summary.offChainPlaintextBytes.p50} B plaintext`);
  return { repetitions: samples.length, modelOutput: state.output.recommendation, summary };
}

// ---------------------------------------------------------------- 3. tamper detection

function replaceAt(text, index, char) {
  return text.slice(0, index) + char + text.slice(index + 1);
}

function textMutations(rand) {
  return [
    ['replace one character', (t) => { const i = Math.floor(rand() * t.length); return replaceAt(t, i, t[i] === 'x' ? 'y' : 'x'); }],
    ['insert one character', (t) => { const i = Math.floor(rand() * (t.length + 1)); return `${t.slice(0, i)}q${t.slice(i)}`; }],
    ['delete one character', (t) => { const i = Math.floor(rand() * t.length); return t.slice(0, i) + t.slice(i + 1); }],
    ['append trailing space', (t) => `${t} `],
    ['change letter case', (t) => { const i = t.search(/[a-z]/); return replaceAt(t, i, t[i].toUpperCase()); }],
    ['Unicode look-alike (Latin a -> Cyrillic a)', (t) => t.replace('a', '\u0430')],
    ['Unicode normalization NFC -> NFD (same visible text)', (t) => t.normalize('NFD')],
    ['emptied', () => ''],
  ];
}

function objectMutations(rand) {
  const flip = (value) => (value === 'ALLOW' ? 'DENY' : 'ALLOW');
  const bound = ['contextHash', 'claimsHash', 'justificationHash', 'policyVersion', 'policyHash', 'modelVersion'];
  const list = [
    ['flip recommendation value', (m) => ({ ...m, recommendation: flip(m.recommendation) }), true],
    ['flip value in value and output together', (m) => ({ ...m, recommendation: flip(m.recommendation), output: { ...m.output, recommendation: flip(m.recommendation) } }), true],
    ['one character of the explanation', (m) => { const r = m.output.reason; const i = Math.floor(rand() * r.length); return { ...m, output: { ...m.output, reason: replaceAt(r, i, r[i] === 'x' ? 'y' : 'x') } }; }, true],
    ['reason code', (m) => ({ ...m, output: { ...m.output, reason_code: m.output.reason_code === 'POLICY_SATISFIED' ? 'NOT_ASSIGNED' : 'POLICY_SATISFIED' } }), true],
    ['add a policy reference', (m) => ({ ...m, output: { ...m.output, policy_refs: [...m.output.policy_refs, 'GP-DEFAULT:C1@v1'] } }), true],
    ['generation status', (m) => ({ ...m, generationStatus: 'INVALID_OUTPUT' }), true],
    ['request id', (m) => ({ ...m, requestId: `${m.requestId}X` }), true],
    ...bound.map((field) => [`provenance.${field}`, (m) => ({ ...m, provenance: { ...m.provenance, [field]: field === 'policyVersion' || field === 'modelVersion' ? `${m.provenance[field]}-x` : 'f'.repeat(64) } }), true]),
    ['add an unknown field', (m) => ({ ...m, note: 'added' }), true],
    ['remove the output', (m) => ({ ...m, output: null }), true],
    ['reorder keys at every depth (same content)', (m) => reorder(m), false],
  ];
  return list;
}

/** The same JSON value with object keys in reverse insertion order, at every depth. */
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])]));
  }
  return value;
}

async function runTamper(args, v3, log) {
  const { CALLERS } = v3.helpers;
  const { hashText, canonicalJson } = require(path.join(CC, 'lib', 'dias', 'commitments.js'));
  const { provenancePayload, verifyProvenance, SIGNED_FIELDS } = require(path.join(CC, 'lib', 'dias', 'recommendationCommitment.js'));
  const { verifyOffChainObjects } = require(path.join(BACKEND, 'src', 'dias', 'offChainVerification.js'));
  const { checkRecommendationIntegrity } = require(path.join(BACKEND, 'src', 'dias', 'recommendationIntegrity.js'));
  const { buildRecommendationObject, recommendationHashOf, modelVersionOf } = require(path.join(BACKEND, 'src', 'dias', 'recommendationObject.js'));
  const { MODEL } = require(path.join(BACKEND, 'test', 'fixtures', 'decisionFixtures.js'));
  const rand = mulberry32(args.seed + 3);
  const tally = new Map();
  const count = (group, mutation, expectedChange, fields) => {
    const key = `${group}|${mutation}`;
    if (!tally.has(key)) tally.set(key, { group, mutation, expectedChange, trials: 0, ...Object.fromEntries(Object.keys(fields).map((k) => [k, 0])) });
    const row = tally.get(key);
    row.trials += 1;
    for (const [k, v] of Object.entries(fields)) row[k] += v ? 1 : 0;
  };
  let baselineFalseAlarms = 0;
  let contractRejections = 0;
  let contractAttempts = 0;

  for (let i = 0; i < args.cases; i += 1) {
    const world = await v3.world.createDiasWorld().seed();
    // Each text carries one precomposed accented word (U+00E9), so the NFD mutation changes bytes.
    const justification = `${syntheticText(rand, 20, 40)} Ref. caf\u00e9.`;
    const note = `${syntheticText(rand, 30, 70)} Ref. caf\u00e9.`;
    const value = rand() < 0.5 ? 'ALLOW' : 'DENY';
    const decision = rand() < 0.5 ? 'FORCE_ALLOW' : 'FORCE_DENY';
    const { result: request } = await world.submit(CALLERS.inspector, { justification });
    const stored = world.readRequest(request.requestId);
    const binding = {
      contextHash: stored.verifiedRequestHash, claimsHash: stored.requesterClaimsHash,
      justificationHash: stored.justificationHash, policyVersion: stored.policyVersion, policyHash: stored.policyHash,
    };
    const output = value === 'ALLOW'
      ? { recommendation: 'ALLOW', reason_code: 'POLICY_SATISFIED', reason: syntheticText(rand, 15, 30), policy_refs: ['GP-RBAC:C2@v1'], missing_evidence: [], review_flags: [] }
      : { recommendation: 'DENY', reason_code: 'CROSS_JURISDICTION', reason: syntheticText(rand, 15, 30), policy_refs: ['GP-JURIS:C1@v1'], missing_evidence: [], review_flags: [] };
    const object = buildRecommendationObject({
      requestId: request.requestId, result: { generationStatus: 'OK', recommendation: output, provenance: {} }, binding, model: MODEL,
    });
    const input = world.commitmentFor(request.requestId, {
      recommendation: value, modelVersion: modelVersionOf(MODEL), signedOverrides: { recommendationHash: recommendationHashOf(object) },
    });
    await world.commit(request.requestId, input);
    const noteHash = hashText('note', note);
    await world.run(CALLERS.auditor, world.nextTx('AUDIT'), (ctx) => world.contracts.access.SubmitAuditorDecision(
      ctx, request.requestId, decision, noteHash, ''));
    const { result: trail } = await world.run(CALLERS.auditor, world.nextTx('TRAIL'),
      (ctx) => world.contracts.audit.GetRequestAuditTrail(ctx, request.requestId));
    const entry = { justification, recommendationObject: object, auditorNote: { reason: note, noteHash } };
    const clean = verifyOffChainObjects({ trail, entry });
    if (Object.values(clean).some((item) => item.status !== 'verified')) baselineFalseAlarms += 1;

    // Off-chain text objects: h_J and h_N.
    for (const [group, field] of [['justification (h_J)', 'justification'], ['auditor note (h_N)', 'note']]) {
      for (const [mutation, mutate] of textMutations(rand)) {
        const original = field === 'note' ? note : justification;
        const changed = mutate(original);
        if (changed === original) throw new Error(`text mutation '${mutation}' changed nothing`);
        const changedEntry = field === 'note'
          ? { ...entry, auditorNote: { ...entry.auditorNote, reason: changed } }
          : { ...entry, justification: changed };
        const status = verifyOffChainObjects({ trail, entry: changedEntry })[field === 'note' ? 'note' : 'justification'].status;
        count(group, mutation, changed !== original, { detected: status !== 'verified' });
      }
      const missingEntry = field === 'note' ? { ...entry, auditorNote: null } : { ...entry, justification: undefined };
      const status = verifyOffChainObjects({ trail, entry: missingEntry })[field === 'note' ? 'note' : 'justification'].status;
      count(group, 'object deleted', true, { detected: status === 'missing' });
    }

    // Recommendation object M: which check catches what (ablation).
    const kappa = trail.recommendationCommitment;
    const naive = crypto.createHash('sha256').update(JSON.stringify(object)).digest('hex');
    for (const [mutation, mutate, expectedChange] of objectMutations(rand)) {
      const changed = mutate(object);
      const sameContent = canonicalJson(changed) === canonicalJson(object);
      if (sameContent === expectedChange) throw new Error(`object mutation '${mutation}' has unexpected effect`);
      const integrity = checkRecommendationIntegrity({ commitment: kappa, recommendationObject: changed });
      const digestProblem = integrity.problems.some((problem) => /h_M|canonical form/.test(problem));
      const bindingProblem = integrity.problems.some((problem) => !/h_M|canonical form/.test(problem));
      const naiveChanged = crypto.createHash('sha256').update(JSON.stringify(changed)).digest('hex') !== naive;
      count('recommendation object (h_M)', mutation, expectedChange, {
        detected: integrity.status !== 'verified',
        detectedByDigestOnly: digestProblem,
        detectedByFieldBindingOnly: bindingProblem,
        flaggedByNaiveHash: naiveChanged,
      });
    }
    count('recommendation object (h_M)', 'object deleted', true, {
      detected: checkRecommendationIntegrity({ commitment: kappa, recommendationObject: null }).status === 'missing-object',
      detectedByDigestOnly: false, detectedByFieldBindingOnly: false, flaggedByNaiveHash: false,
    });

    // κ itself: a signed field changed after signing. Checked by the signature
    // offline, and by the contract when such a κ is submitted for a fresh request.
    const publicKeyPem = world.signer.publicKeyPem;
    for (const field of SIGNED_FIELDS.filter((name) => name !== 'signerKeyId')) {
      const forged = { ...kappa, [field]: forgeValue(field, kappa[field]) };
      const verified = verifyProvenance({ publicKeyPem, payload: provenancePayload({ channel: 'diaschannel', ...forged }), signature: kappa.signature });
      count('commitment κ (signature)', `signed field ${field}`, true, { detected: !verified });
    }
    if (i < Math.min(args.cases, 20)) {
      const { result: fresh } = await world.submit(CALLERS.constable, { justification });
      const freshInput = world.commitmentFor(fresh.requestId, { recommendation: 'ALLOW' });
      for (const field of ['recommendation', 'recommendationHash', 'modelVersion']) {
        contractAttempts += 1;
        const forged = { ...freshInput, [field]: forgeValue(field, freshInput[field]) };
        try {
          await world.commit(fresh.requestId, forged);
        } catch (_error) {
          contractRejections += 1;
        }
      }
    }
  }
  const rows = [...tally.values()];
  for (const row of rows) {
    row.detectionRate = round(row.detected / row.trials, 4);
    if (row.detectedByDigestOnly !== undefined) {
      row.digestOnlyRate = round(row.detectedByDigestOnly / row.trials, 4);
      row.fieldBindingOnlyRate = round(row.detectedByFieldBindingOnly / row.trials, 4);
      row.naiveHashFlagRate = round(row.flaggedByNaiveHash / row.trials, 4);
    }
  }
  log(`tamper: ${rows.length} mutation classes x ${args.cases} cases; clean-copy false alarms ${baselineFalseAlarms}; contract rejected ${contractRejections}/${contractAttempts} forged κ`);
  return {
    cases: args.cases, cleanCopyFalseAlarms: baselineFalseAlarms,
    contractForgedCommitments: { attempts: contractAttempts, rejected: contractRejections }, rows,
  };
}

function forgeValue(field, value) {
  if (field === 'recommendation') return value === 'ALLOW' ? 'DENY' : 'ALLOW';
  if (field === 'generationStatus') return value === 'OK' ? 'INVALID_OUTPUT' : 'OK';
  if (field === 'policyVersion' || field === 'modelVersion') return `${value}-x`;
  return value === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
}

// ---------------------------------------------------------------- 4. policy-update invalidation

const SCOPES = (() => {
  const list = [];
  for (const recordId of ['FIR-1', 'FIR-2']) {
    for (const action of ['view', 'export', 'annotate']) {
      for (const purpose of ['investigation', 'forensic-analysis', 'prosecution', 'judicial-proceeding', 'audit-review', 'defense-preparation']) {
        list.push({ recordId, action, purpose });
      }
    }
  }
  return list;
})();

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: String(error.message || error).slice(0, 160) };
  }
}

async function readyDocument(world, CALLERS, outcomeId, recordId) {
  const { result: documentRequest } = await world.run(CALLERS.inspector, world.nextTx('DOCREQ'),
    (ctx) => world.contracts.records.CreateFullDocumentRequest(ctx, recordId, outcomeId));
  await world.run(CALLERS.constable, world.nextTx('UPLOAD'), (ctx) => world.contracts.records.UploadRequestedDocument(
    ctx, documentRequest.requestId, 'b'.repeat(64), `vault-pdf://police/${documentRequest.requestId}`, 'case-file.pdf', 'application/pdf'));
  return documentRequest.requestId;
}

async function runPolicy(args, v2, v3, log) {
  const { CALLERS } = v3.helpers;
  const world = await v3.world.createDiasWorld().seed();
  const download = (documentId) => world.run(CALLERS.inspector, world.nextTx('DOWNLOAD'),
    (ctx) => world.contracts.records.AuthorizeRequestedDocumentRead(ctx, documentId));
  // Split the scopes: a third become reusable authorizations, a third stay
  // pending (half with κ committed), a third are allowed reviews whose document
  // is ready but not yet downloaded. The reusable ones also get a reused grant
  // with a ready document.
  const authorizations = [];
  const pendingNoKappa = [];
  const pendingWithKappa = [];
  const readyReviewed = [];
  const readyReused = [];
  const setupFailures = [];
  for (const [index, scope] of SCOPES.entries()) {
    const kind = index % 3;
    const made = await attempt(async () => {
      const { result: request } = await world.submit(CALLERS.inspector, scope);
      if (kind === 0) {
        const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'DENY');
        authorizations.push({ scope, authorizationId: result.dynamicAuthorization.authorizationId });
        const { result: repeat } = await world.submit(CALLERS.inspector, scope);
        if (repeat.processingPath !== 'dynamic-authorization') throw new Error('reuse expected before the change');
        if (scope.action === 'view') readyReused.push(await readyDocument(world, CALLERS, repeat.outcomeId, scope.recordId));
      } else if (kind === 1) {
        if (index % 2 === 0) {
          await world.commit(request.requestId, world.commitmentFor(request.requestId, { recommendation: 'DENY' }));
          pendingWithKappa.push(request.requestId);
        } else pendingNoKappa.push(request.requestId);
      } else {
        const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW');
        if (scope.action === 'view') readyReviewed.push(await readyDocument(world, CALLERS, result.accessOutcome.outcomeId, scope.recordId));
      }
    });
    if (!made.ok) setupFailures.push({ scope, error: made.error });
  }
  // A control: one download of each kind before the change must succeed.
  const controlBefore = {
    reviewed: readyReviewed.length ? (await attempt(() => download(readyReviewed[0]))).ok : null,
    reused: readyReused.length ? (await attempt(() => download(readyReused[0]))).ok : null,
  };

  await world.changePolicy('dias-governance-policy-v2', 'e'.repeat(64));

  const tally = (items) => ({ total: items.length, refused: items.filter((item) => !item.ok).length, accepted: items.filter((item) => item.ok).length });
  const reuseAfter = [];
  const reissue = [];
  for (const { scope, authorizationId } of authorizations) {
    const { result } = await world.submit(CALLERS.inspector, scope);
    reuseAfter.push({ ok: result.processingPath === 'dynamic-authorization', check: result.dynamicAuthorizationCheck && result.dynamicAuthorizationCheck.outcome });
    if (reissue.length < 5) {
      const { result: decided } = await world.decide(result.requestId, 'FORCE_ALLOW', 'DENY');
      const created = decided.dynamicAuthorization;
      const old = world.readState('diasAuthorization', authorizationId);
      reissue.push({ ok: Boolean(created) && created.policyVersion === 'dias-governance-policy-v2', oldStatus: old && old.status, newGeneration: created && created.generation });
    }
  }
  const decisionsAfter = [];
  for (const requestId of pendingWithKappa) decisionsAfter.push(await attempt(() => world.decide(requestId, 'FORCE_DENY', 'DENY')));
  const kappaAfter = [];
  for (const requestId of pendingNoKappa) kappaAfter.push(await attempt(() => world.commit(requestId, world.commitmentFor(requestId, { recommendation: 'DENY' }))));
  const expiryAfter = [];
  for (const requestId of [...pendingNoKappa, ...pendingWithKappa]) expiryAfter.push(await attempt(() => world.expire(requestId)));
  const releaseReviewedAfter = [];
  for (const documentId of readyReviewed.slice(1)) releaseReviewedAfter.push(await attempt(() => download(documentId)));
  const releaseReusedAfter = [];
  for (const documentId of readyReused.slice(1)) releaseReusedAfter.push(await attempt(() => download(documentId)));

  // v2 baseline: the same authorizations, then the same repeat requests. v2 has
  // no policy input, so there is nothing to change; reuse simply continues.
  const v2World = await v2.world.createDiasWorld().seed();
  const v2Reuse = [];
  for (const { scope } of authorizations) {
    const input = JSON.stringify({ action: scope.action, purpose: scope.purpose });
    const { result: first } = await v2World.run(v2.helpers.CALLERS.inspector, v2World.nextTx('SUBMIT'), (ctx) => v2World.contracts.access.CreateAccessRequest(ctx, scope.recordId, input));
    await v2World.run(v2.helpers.CALLERS.auditor, v2World.nextTx('AUDIT'), (ctx) => v2World.contracts.access.SubmitAuditorDecision(ctx, first.requestId, 'FORCE_ALLOW', 'DENY', ''));
    const { result: repeat } = await v2World.run(v2.helpers.CALLERS.inspector, v2World.nextTx('SUBMIT'), (ctx) => v2World.contracts.access.CreateAccessRequest(ctx, scope.recordId, input));
    v2Reuse.push({ ok: repeat.processingPath === 'dynamic-authorization' });
  }

  const result = {
    scopes: SCOPES.length,
    setupFailures,
    controlDownloadsBeforeChange: controlBefore,
    v3: {
      reuseOfOldAuthorization: { ...tally(reuseAfter), missReasons: [...new Set(reuseAfter.map((item) => item.check))] },
      decisionOnPendingRequestWithKappa: { ...tally(decisionsAfter), errors: [...new Set(decisionsAfter.filter((i) => !i.ok).map((i) => i.error))] },
      kappaCommitOnPendingRequest: { ...tally(kappaAfter), errors: [...new Set(kappaAfter.filter((i) => !i.ok).map((i) => i.error))] },
      expiryOfPendingRequest: tally(expiryAfter),
      releaseOfReviewedGrant: { ...tally(releaseReviewedAfter), errors: [...new Set(releaseReviewedAfter.filter((i) => !i.ok).map((i) => i.error))] },
      releaseOfReusedGrant: { ...tally(releaseReusedAfter), errors: [...new Set(releaseReusedAfter.filter((i) => !i.ok).map((i) => i.error))] },
      reissueUnderNewPolicy: { total: reissue.length, ok: reissue.filter((item) => item.ok).length, oldStatuses: [...new Set(reissue.map((item) => item.oldStatus))], newGenerations: [...new Set(reissue.map((item) => item.newGeneration))] },
    },
    v2Baseline: { note: 'v2 binds no policy version; a policy change cannot reach the ledger', reuseContinues: tally(v2Reuse).accepted, total: v2Reuse.length },
  };
  log(`policy: v3 reuse after change ${result.v3.reuseOfOldAuthorization.accepted}/${result.v3.reuseOfOldAuthorization.total}; v2 reuse continues ${result.v2Baseline.reuseContinues}/${result.v2Baseline.total}`);
  return result;
}

// ---------------------------------------------------------------- main

function environment(args) {
  const git = (...cmd) => { try { return execFileSync('git', ['-C', ROOT, ...cmd]).toString().trim(); } catch (_e) { return null; } };
  const cpus = os.cpus();
  return {
    node: process.version, platform: `${os.platform()} ${os.release()}`, arch: os.arch(),
    cpuModel: cpus.length ? cpus[0].model : null, logicalCpus: cpus.length, totalMemoryBytes: os.totalmem(),
    v3SourceCommit: git('rev-parse', 'HEAD'), v3WorktreeClean: git('status', '--porcelain') === '',
    v2BaselineCommit: BASELINE_COMMIT, args,
    harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  fs.mkdirSync(out, { recursive: true });
  const logLines = [];
  const log = (line) => { const stamped = `[${new Date().toISOString()}] ${line}`; logLines.push(stamped); console.log(stamped); };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dias-integrity-'));
  const write = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const env = environment(args);
    write('config.json', {
      experiment: 'v3 integrity, offline', kind: 'microbenchmarks and simulated workflows on the in-process mock Fabric stub; not live Fabric results',
      seed: args.seed, iterations: args.iterations, warmup: args.warmup, workflowRepetitions: args.workflows, tamperCases: args.cases,
      v2Baseline: { commit: BASELINE_COMMIT, extractedWith: 'git archive (read-only copy in a temporary directory)' },
    });
    write('environment.json', env);
    log(`start: node ${env.node}, ${env.cpuModel}, v3 ${env.v3SourceCommit}, clean=${env.v3WorktreeClean}`);
    const v3 = loadV3();
    const v2 = loadV2(path.join(scratch, 'v2'));
    write('latency.json', runLatency(args, log));
    write('workflows.json', await runWorkflows(args, v2, v3, log));
    write('end-to-end.json', await runEndToEnd(args, v3, scratch, log));
    write('tamper.json', await runTamper(args, v3, log));
    write('policy-invalidation.json', await runPolicy(args, v2, v3, log));
    log('done');
  } finally {
    fs.writeFileSync(path.join(out, 'run.log'), `${logLines.join('\n')}\n`);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
