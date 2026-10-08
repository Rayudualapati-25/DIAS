#!/usr/bin/env node
'use strict';

/**
 * E5: whole-system runs at 10, 25, 50, 75 and 100 simultaneous users.
 *
 * Follows testbed/load/generated/burst-plan.json exactly: five warm-up
 * workflows (not measured), then for every level three repetitions in which
 * users 1..L each start one workflow at the same moment. Between batches the
 * system is left idle for a fixed cool-down, so batches do not overlap and the
 * asynchronous ledger audit writes of one batch finish before the next starts.
 *
 * Output (in --out): requests.jsonl (one row per workflow), batches.json (batch
 * windows for the resource data), run.json (settings and totals).
 *
 * Usage: node testbed/load/run-burst.js --url http://dias-backend:3001/api \
 *          --out /results/<run> [--levels 10,25]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AUDITORS, createClient, createWatcher, now, round, runWorkflow, sleep,
} = require('./workflow');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts['review-dir']) throw new Error('--review-dir is retired; reviews are accessed through the backend API');
  const url = opts.url || 'http://dias-backend:3001/api';
  const outDir = opts.out;
  if (!outDir) throw new Error('--out is required');
  const cooldownMs = Number(opts.cooldown || 30000);
  const timeoutMs = Number(opts.timeout || 3600000);
  const planDir = path.join(__dirname, 'generated');
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, 'burst-plan.json'), 'utf8'));
  const planMeta = JSON.parse(fs.readFileSync(path.join(planDir, 'plan-meta.json'), 'utf8'));
  const users = new Map(JSON.parse(fs.readFileSync(path.join(planDir, 'users.json'), 'utf8'))
    .map((user) => [user.username, user]));
  const levels = opts.levels ? opts.levels.split(',').map(Number) : plan.meta.levels;
  const batches = plan.batches.filter((batch) => levels.includes(batch.level));

  fs.mkdirSync(outDir, { recursive: true });
  if (['run.json', 'requests.jsonl'].some(name => fs.existsSync(path.join(outDir, name)))) {
    throw new Error(`${outDir} already holds run evidence; select a fresh output directory`);
  }
  const rowsFile = path.join(outDir, 'requests.jsonl');
  const record = (row) => fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
  const client = createClient(url);
  const watcher = createWatcher(client);
  const startedAt = now();

  // Sign everyone in first, so measured time starts at the access request.
  // Each sign-in adds one ledger audit write, which the pause below absorbs.
  await inChunks([...users.keys(), ...AUDITORS], 10, (username) => client.login(username));
  process.stdout.write(`signed in ${users.size + AUDITORS.length} identities\n`);
  await sleep(cooldownMs);

  for (const request of plan.warmup) {
    const row = await runWorkflow({
      client, watcher, request, user: users.get(request.username), timeoutMs,
      extra: { phase: 'warmup', level: 0, repetition: 0 },
    });
    record(row);
    process.stdout.write(`warm-up ${request.id}: ${row.status} ${row.recommendation || row.error || ''}\n`);
  }
  await sleep(cooldownMs);

  const windows = [];
  for (const batch of batches) {
    const batchStart = now();
    const rows = await Promise.all(batch.requests.map((request) => runWorkflow({
      client, watcher, request, user: users.get(request.username), timeoutMs,
      extra: { phase: 'measured', level: batch.level, repetition: batch.repetition, batchStartedAt: round(batchStart) },
    })));
    const batchEnd = now();
    rows.forEach(record);
    const completed = rows.filter((row) => row.status === 'completed');
    const window = {
      level: batch.level,
      repetition: batch.repetition,
      requested: rows.length,
      completed: completed.length,
      failed: rows.length - completed.length,
      startedAt: round(batchStart),
      finishedAt: round(batchEnd),
      durationMs: round(batchEnd - batchStart),
      workflowsPerMinute: round((completed.length / ((batchEnd - batchStart) / 60000))),
    };
    windows.push(window);
    fs.writeFileSync(path.join(outDir, 'batches.json'), `${JSON.stringify(windows, null, 2)}\n`);
    process.stdout.write(`level ${batch.level} rep ${batch.repetition}: ${completed.length}/${rows.length} in ${(window.durationMs / 1000).toFixed(1)} s\n`);
    await sleep(cooldownMs);
  }

  const finishedAt = now();
  fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify({
    experiment: 'E5 whole-system burst runs',
    startedAt: round(startedAt),
    finishedAt: round(finishedAt),
    startedAtUtc: new Date(startedAt).toISOString(),
    finishedAtUtc: new Date(finishedAt).toISOString(),
    apiUrl: url,
    loadGeneratorHost: os.hostname(),
    levels,
    repetitions: plan.meta.repetitions,
    cooldownMs,
    planSha256: planMeta.planSha256,
    auditorPolicy: 'automated: follows the recommendation as soon as it is ready; no human review time',
    batches: windows,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(`burst run failed: ${error.stack || error}`);
  process.exit(1);
});
