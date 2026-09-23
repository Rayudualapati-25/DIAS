'use strict';

/**
 * Shared plumbing for the paper experiments.
 *
 * This file adds no measurement logic of its own. It verifies that the system
 * is in the frozen configuration, stamps that configuration onto every result
 * file, and re-exports the repository's existing API and Fabric clients so the
 * experiments do not carry duplicate copies of them.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const RESULTS = path.join(__dirname, 'results');

// The repository's own clients and policy modules. Reused, never reimplemented.
const fabric = require(path.join(REPO, 'backend/src/fabric/gateway'));
const policy = require(path.join(REPO, 'chaincode/crimerecords/lib/policy/policyV1'));
const controlled = require(path.join(REPO, 'chaincode/crimerecords/lib/policy/controlledDecision'));
const policyEngine = require(path.join(REPO, 'chaincode/crimerecords/lib/policy/policyEngine'));
const reasonDecisions = require(path.join(REPO, 'chaincode/crimerecords/lib/policy/reasonDecisions'));

const API = process.env.API_BASE || 'http://127.0.0.1:3001/api';
const MODEL_URL = process.env.LLM_POLICY_URL || 'http://127.0.0.1:8080/v1';

/**
 * The configuration these experiments are only valid against. A mismatch means
 * the numbers cannot be compared with the rest of the evaluation, so preflight
 * stops rather than reconfiguring anything.
 */
const FROZEN = Object.freeze({
  organizations: 6,
  chaincode: 'crimerecords',
  chaincodeVersion: '4.0',
  chaincodePackageHash:
    '43b9336fbc6691253b698e681bff3cb06820ed70e07197ceb6e4655e5e7f5537',
  endorsement: 'ImplicitMeta MAJORITY 4-of-6',
  model: 'qwen3-14b-seba-lora-v6',
  adapterHash:
    '5f5fba8e9e19b2c4b1a2dcd1968100a2e875dde8addd0f89ff0c9385fcd601fe',
  policyVersion: 'crime-policy-v2',
});

// ---------------------------------------------------------------- HTTP client

/**
 * A transport failure carries almost nothing in its own message: node's fetch
 * reports every socket-level problem as the same "fetch failed". The underlying
 * cause chain is where the useful detail lives (ECONNRESET, ECONNREFUSED,
 * UND_ERR_SOCKET and so on), so it is unwrapped here and attached to the thrown
 * error. Nothing is retried: a transport failure is evidence and it is reported
 * as such, not smoothed over until the run looks clean.
 */
function describeCause(error) {
  const chain = [];
  let cause = error.cause;
  while (cause && chain.length < 5) {
    chain.push(`${cause.name || 'Error'}${cause.code ? `(${cause.code})` : ''}: ${cause.message}`);
    cause = cause.cause;
  }
  return chain;
}

/**
 * Ceiling on a single API call.
 *
 * The API answers a decision request by polling for at most 90 s and then
 * returning 202, so every legitimate response arrives well inside this. The
 * ceiling exists because a request that never settles is otherwise unbounded:
 * an experiment observed a socket to the API move to CLOSED while the fetch
 * promise stayed pending, which stalled a run indefinitely and produced no
 * evidence at all. A timeout converts that into a recorded, classified failure.
 * It is deliberately above the API's own ceiling so it can never truncate a
 * response the system would have produced.
 */
const API_TIMEOUT_MS = Number(process.env.PAPER_API_TIMEOUT_MS || 120000);

async function api(method, route, { token, body, raw = false } = {}) {
  let res;
  const started = Date.now();
  try {
    res = await fetch(API + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const chain = describeCause(error);
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    const detailed = new Error(
      timedOut
        ? `no response from ${method} ${route} within ${API_TIMEOUT_MS} ms `
          + `(the API's own decision ceiling is lower, so this is a transport stall)`
        : `transport failure on ${method} ${route}: ${error.message}`
          + `${chain.length ? ` | cause: ${chain.join(' <- ')}` : ' | no cause reported'}`
    );
    detailed.transport = true;
    detailed.timedOut = timedOut;
    detailed.causeChain = chain;
    detailed.route = `${method} ${route}`;
    detailed.elapsedMs = Date.now() - started;
    throw detailed;
  }
  if (raw) return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
  return { status: res.status, json: await res.json() };
}

async function login(username) {
  const { json } = await api('POST', '/auth/login', { body: { username } });
  if (!json.success) throw new Error(`login ${username}: ${json.error}`);
  return json.data.token;
}

/** Log in every identity an experiment needs, once. */
async function tokensFor(usernames) {
  const tokens = {};
  for (const u of usernames) tokens[u] = await login(u);
  return tokens;
}

// ------------------------------------------------------------------ provenance

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function hardware() {
  const sysctl = (key) => {
    try {
      return execFileSync('sysctl', ['-n', key], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const bytes = Number(sysctl('hw.memsize') || 0);
  return {
    cpu: sysctl('machdep.cpu.brand_string') || os.cpus()[0]?.model || null,
    cores: os.cpus().length,
    ramGB: bytes ? Math.round(bytes / 1024 ** 3) : null,
    // Apple silicon has unified memory; the GPU shares the figure above.
    gpu: /Apple/.test(sysctl('machdep.cpu.brand_string') || '')
      ? `${sysctl('machdep.cpu.brand_string')} integrated GPU (unified memory)` : null,
    platform: `${os.type()} ${os.release()}`,
    osVersion: (() => {
      try {
        return execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
      } catch { return null; }
    })(),
    node: process.version,
    modelRuntime: 'MLX-LM (OpenAI-compatible server)',
  };
}

/**
 * Provenance recorded on every result file.
 *
 * Two commits matter and they are not the same one. `frozenBaseline` is the
 * implementation under measurement (the paper-freeze-v1 tag). `harnessCommit`
 * is whatever HEAD is when the experiment runs, which also carries the
 * measurement harness and any measurement-only instrumentation. Reporting only
 * one of them would attribute results to the wrong tree.
 */
const FROZEN_TAG = 'paper-freeze-v1';

function provenance() {
  const dirty = git('status', '--porcelain');
  const baseline = git('rev-list', '-n', '1', FROZEN_TAG);
  const head = git('rev-parse', 'HEAD');
  return {
    frozenBaseline: baseline,
    frozenBaselineTag: FROZEN_TAG,
    harnessCommit: head,
    harnessIsBaseline: baseline === head,
    commitsAheadOfBaseline: baseline && head && baseline !== head
      ? Number(git('rev-list', '--count', `${FROZEN_TAG}..HEAD`) || 0) : 0,
    treeHash: git('rev-parse', 'HEAD^{tree}'),
    dirty: dirty === null ? null : dirty.length > 0,
    uncommittedPaths: dirty ? dirty.split('\n').filter(Boolean).length : 0,
  };
}

// ------------------------------------------------------------------- preflight

/** Read the live governance state the experiments depend on. */
async function liveState() {
  const [model, activePolicy, pending] = await Promise.all([
    fabric.evaluate('audit', 'sp.north', 'PolicyContract', 'GetActiveLLMPolicyModel'),
    fabric.evaluate('audit', 'sp.north', 'PolicyContract', 'GetActivePolicyVersion'),
    fabric.evaluate('audit', 'sp.north', 'AccessContract', 'QueryPendingEscalations'),
  ]);
  return { model, activePolicy, pending: pending.length };
}

function chaincodePackages() {
  try {
    const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
    const rows = names.split('\n').filter((n) => n.startsWith('dev-peer0'));
    return [...new Set(rows.map((n) => n.replace(/^.*crimerecords_/, '')))];
  } catch {
    return [];
  }
}

function peerCount() {
  try {
    const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' });
    return names.split('\n').filter((n) => /^peer0\./.test(n)).length;
  } catch {
    return 0;
  }
}

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Verify the frozen configuration. Throws with every difference listed; never
 * reconfigures anything. `requirePending` is relaxed only by the experiment
 * that deliberately leaves escalations behind.
 */
async function preflight({ requirePending = 0, requireServices = true } = {}) {
  const problems = [];
  const notes = [];

  if (!fs.existsSync(path.join(REPO, '.env'))) {
    problems.push('.env is missing — run `cp .env.example .env` before any experiment');
  }

  const packages = chaincodePackages();
  if (packages.length !== 1) {
    problems.push(`peers run ${packages.length} distinct chaincode packages: ${packages.join(', ')}`);
  } else if (!packages[0].includes(FROZEN.chaincodePackageHash)) {
    problems.push(`chaincode package is ${packages[0]}, expected ${FROZEN.chaincodeVersion}-${FROZEN.chaincodePackageHash}`);
  }

  const peers = peerCount();
  if (peers !== FROZEN.organizations) {
    problems.push(`${peers} peers running, expected ${FROZEN.organizations}`);
  }

  let live = null;
  try {
    live = await liveState();
  } catch (error) {
    problems.push(`cannot read ledger governance state: ${error.message}`);
  }

  if (live) {
    if (live.model?.modelVersion !== FROZEN.model) {
      problems.push(`active model is ${live.model?.modelVersion}, expected ${FROZEN.model}`);
    }
    if (live.model?.adapterHash !== FROZEN.adapterHash) {
      problems.push(`registered adapter is ${live.model?.adapterHash}, expected ${FROZEN.adapterHash}`);
    }
    if (live.activePolicy?.version !== FROZEN.policyVersion) {
      problems.push(`active policy is ${live.activePolicy?.version}, expected ${FROZEN.policyVersion}`);
    }
    if (requirePending !== null && live.pending !== requirePending) {
      problems.push(`${live.pending} pending escalation(s) on the ledger, expected ${requirePending}`);
    }
  }

  if (requireServices) {
    if (!await reachable(`${API}/health`)) problems.push('backend is not reachable');
    if (!await reachable(`${MODEL_URL}/models`)) problems.push('model server is not reachable');
    try {
      const ps = execFileSync('pgrep', ['-f', 'src/ai/start.js'], { encoding: 'utf8' });
      if (!ps.trim()) problems.push('AI listener is not running');
    } catch {
      problems.push('AI listener is not running');
    }
  }

  const prov = provenance();
  if (prov.dirty) {
    notes.push(`working tree has ${prov.uncommittedPaths} uncommitted path(s); results record the tree hash as well as the commit`);
  }

  if (problems.length) {
    const message = ['SYSTEM IS NOT IN THE FROZEN CONFIGURATION — refusing to run:',
      ...problems.map((p) => `  - ${p}`),
      '', 'Nothing was reconfigured. Fix the differences and re-run.'].join('\n');
    throw new Error(message);
  }
  return { live, provenance: prov, notes };
}

// -------------------------------------------------------------------- metadata

function metadata(experiment, extra = {}) {
  return {
    experiment,
    timestamp: new Date().toISOString(),
    ...provenance(),
    ...FROZEN,
    hardware: hardware(),
    ...extra,
  };
}

// ----------------------------------------------------------------- statistics

/** Descriptive statistics for a latency sample. p99 only when n justifies it. */
function stats(values) {
  const xs = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return { n: 0 };
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return {
    n: xs.length,
    mean: round(mean),
    median: round(q(0.5)),
    p95: round(q(0.95)),
    ...(xs.length >= 100 ? { p99: round(q(0.99)) } : {}),
    sd: round(sd),
    min: round(xs[0]),
    max: round(xs[xs.length - 1]),
  };
}

/** Milliseconds and other magnitudes: two decimals is plenty. */
const round = (x) => Math.round(x * 100) / 100;

/**
 * Accuracy proportions keep four decimals. Two would turn 0.585 into 0.59 and
 * silently change a number the paper quotes.
 */
const ratio = (x) => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);

// -------------------------------------------------------------------- output

function ensureResults() {
  fs.mkdirSync(RESULTS, { recursive: true });
}

/** One JSON file per experiment: metadata, summary, and the raw runs. */
function writeJson(name, payload) {
  ensureResults();
  const file = path.join(RESULTS, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

/** Paper-friendly table. Rows are objects; columns come from the first row. */
function writeCsv(name, rows) {
  ensureResults();
  const file = path.join(RESULTS, `${name}.csv`);
  if (!rows.length) {
    fs.writeFileSync(file, '');
    return file;
  }
  const cols = [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => cols.map((c) => cell(r[c])).join(',')).join('\n');
  fs.writeFileSync(file, `${cols.join(',')}\n${body}\n`);
  return file;
}

const banner = (title) => {
  process.stdout.write(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n`);
};

module.exports = {
  REPO, RESULTS, API, MODEL_URL, FROZEN,
  fabric, policy, controlled, policyEngine, reasonDecisions,
  api, login, tokensFor,
  preflight, provenance, hardware, metadata, liveState,
  stats, round, ratio, writeJson, writeCsv, banner,
};
