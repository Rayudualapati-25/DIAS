#!/usr/bin/env node
'use strict';

/**
 * E6: the one-hour run (after InterSnap's resilience test).
 *
 * The 100 users send the requests of testbed/load/generated/steady-plan.json at
 * their planned times: random (Poisson) arrivals averaging six per minute for
 * sixty minutes, below the single model server's capacity, as in normal work.
 * Each workflow also has the reads a person makes: the auditor opens the pending
 * list before reviewing, and the requester reads the outcome afterwards. After
 * the last arrival the run waits for every open workflow to finish.
 *
 * Usage: node testbed/load/run-steady.js --url ... --out /results/<run>
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

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts['review-dir']) throw new Error('--review-dir is retired; reviews are accessed through the backend API');
  const url = opts.url || 'http://dias-backend:3001/api';
  const outDir = opts.out;
  if (!outDir) throw new Error('--out is required');
  const settleMs = Number(opts.settle || 60000);
  const planDir = path.join(__dirname, 'generated');
  const planFile = opts.plan || 'steady-plan.json';
  const plan = JSON.parse(fs.readFileSync(path.join(planDir, planFile), 'utf8'));
  const planMeta = planFile === 'steady-plan.json'
    ? JSON.parse(fs.readFileSync(path.join(planDir, 'plan-meta.json'), 'utf8'))
    : { planSha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(planDir, planFile))).digest('hex') };
  const users = new Map(JSON.parse(fs.readFileSync(path.join(planDir, 'users.json'), 'utf8'))
    .map((user) => [user.username, user]));
  fs.mkdirSync(outDir, { recursive: true });
  if (['run.json', 'requests.jsonl'].some(name => fs.existsSync(path.join(outDir, name)))) {
    throw new Error(`${outDir} already holds run evidence; select a fresh output directory`);
  }
  const rowsFile = path.join(outDir, 'requests.jsonl');
  const client = createClient(url);
  const watcher = createWatcher(client);

  for (const username of [...users.keys(), ...AUDITORS]) await client.login(username);
  process.stdout.write(`signed in ${users.size + AUDITORS.length} identities; settling ${settleMs / 1000} s\n`);
  await sleep(settleMs);

  const t0 = now();
  let finished = 0;
  const all = plan.arrivals.map((request) => new Promise((resolve) => {
    setTimeout(async () => {
      const row = await runWorkflow({
        client, watcher, request, user: users.get(request.username), timeoutMs: 3600000,
        extra: { phase: opts.phase || 'steady', plannedOffsetMs: request.offsetMs, actualOffsetMs: round(now() - t0) },
        auditorListsPending: true, requesterReadsBack: true,
      });
      fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      finished += 1;
      if (finished % 30 === 0) {
        process.stdout.write(`${finished}/${plan.arrivals.length} workflows finished at ${((now() - t0) / 60000).toFixed(1)} min\n`);
      }
      resolve(row);
    }, request.offsetMs);
  }));
  const rows = await Promise.all(all);
  const t1 = now();
  const completed = rows.filter((row) => row.status === 'completed').length;
  fs.writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify({
    experiment: opts.label || 'E6 one-hour steady run',
    planFile,
    startedAt: round(t0),
    lastArrivalAt: round(t0 + plan.arrivals[plan.arrivals.length - 1].offsetMs),
    finishedAt: round(t1),
    startedAtUtc: new Date(t0).toISOString(),
    finishedAtUtc: new Date(t1).toISOString(),
    apiUrl: url,
    loadGeneratorHost: os.hostname(),
    arrivals: plan.arrivals.length,
    completed,
    failed: rows.length - completed,
    ratePerMinute: plan.meta.steadyRatePerMinute,
    planSha256: planMeta.planSha256,
    auditorPolicy: 'automated: follows the recommendation as soon as it is ready; no human review time',
  }, null, 2)}\n`);
  process.stdout.write(`done: ${completed}/${rows.length} completed in ${((t1 - t0) / 60000).toFixed(1)} min\n`);
}

main().catch((error) => {
  console.error(`steady run failed: ${error.stack || error}`);
  process.exit(1);
});
