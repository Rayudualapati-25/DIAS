#!/usr/bin/env node
'use strict';

/** The reuse experiment of the three-setup plan, on the running Mac host. */

const fs = require('fs');
const path = require('path');
const { digestOf } = require('./setup-plan');
const { round } = require('./lib');
const {
  API, LOG_CAP, createClient, environment, eventsCheck, hostLeftIdle, openDesks, openRun, options, quietOn,
  recommendationTime, requireIdleHost, reviewedWorkflow, selected, storeWatcher, verifyReviewed,
} = require('./setup-common');

const USAGE = 'usage: setup-reuse.js --plan plan.json --out DIR --staging DIR [--limit N]';
const NOTE = 'Synthetic three-setup experiment of the reusable authorization; no real case material is evaluated.';

/** One repeat of an authorized request: it must be granted at once by that authorization. */
async function reusedRequest({ item, officerDesk, quiet, authorizationId }) {
  const row = {
    id: item.id, kind: 'repeat', username: item.username, recordId: item.recordId, action: item.action,
    purpose: item.purpose, officerSurface: officerDesk.surface, status: 'failed', stage: 'prepare',
  };
  try {
    Object.assign(row, await officerDesk.prepare(item.username));
    row.stage = 'submit';
    row.quietBeforeRequestMs = round(await quiet());
    row.startedAtUtc = new Date().toISOString();
    Object.assign(row, await officerDesk.submit(item));
    row.reusedOk = row.automatic === true && row.authorizationId === authorizationId;
    if (row.automatic) {
      row.stage = 'outcome';
      Object.assign(row, await officerDesk.outcome(item, row.requestId));
    }
    row.status = 'done';
    row.stage = 'done';
  } catch (error) {
    row.error = String(error.message || error);
  }
  row.finishedAtUtc = new Date().toISOString();
  return row;
}

/** A request that waits although it should not: close it by following the advice, never leave it. */
async function closeByAdvice({ client, watcher, auditor, auditorDesk, requestId, quiet }) {
  await recommendationTime({ client, watcher, requestId, auditor });
  await auditorDesk.open(requestId);
  await quiet();
  return auditorDesk.decide(requestId);
}

/** The ledger's record of a reused request: no advice, no auditor, a grant by this authorization. */
function checkReuse({ trail, entry, authorizationId }) {
  const stages = ((trail && trail.lifecycle) || []).map((event) => event.eventType);
  const summary = (trail && trail.summary) || {};
  const check = (name, ok) => ({ name, ok: Boolean(ok) });
  return [
    check('the ledger holds no LLM recommendation and no auditor decision for it',
      trail && trail.recommendationCommitment === null && !trail.auditorDecision
      && stages.includes('AUDITOR_REVIEW_SKIPPED') && !stages.includes('RECOMMENDATION_COMMITTED')),
    check('the authorization check matched', summary.dynamicAuthorization && summary.dynamicAuthorization.outcome === 'MATCH'),
    check('the access log shows a grant by this authorization, with the LLM not asked',
      entry && entry.outcome === 'GRANTED' && entry.basis === 'DYNAMIC_AUTHORIZATION'
      && entry.llmRecommendation === null && entry.decision === null && entry.authorizationId === authorizationId),
  ];
}

/** One base request through its five steps. Returns its request rows; `state` says how far it came. */
async function runBase({ base, client, watcher, auditor, desks, quiet, created }) {
  const officerDesk = desks.officers[base.officer];
  const auditorDesk = desks.auditors[base.auditor];
  const rows = [];
  const state = { id: base.id, cell: base.cell, status: 'failed', authorizationId: null };
  const keep = (row, kind) => {
    rows.push(Object.assign(row, { baseId: base.id, kind, cell: base.cell, setup: base.setup,
      officerSeat: base.officer, auditorSeat: base.auditor }));
    return row;
  };
  // An override's authorization is noted as soon as the decision reports it, before anything else of the
  // workflow can fail, so the clean-up always knows it.
  const reviewed = (item, kind, mode) => reviewedWorkflow({
    client, watcher, item, auditor, officerDesk, auditorDesk, quiet, mode, overrideReason: NOTE,
  }).then((row) => {
    if (row.overridden && row.authorizationId) created.add(row.authorizationId);
    return keep(row, kind);
  });
  try {
    const first = await reviewed(base.first, 'first', 'override');
    if (first.status !== 'decided') throw new Error(`the first request failed at ${first.stage}: ${first.error}`);
    if (!first.overridden || !first.authorizationId) {
      state.status = 'not-exercised';
      state.reason = first.overridden ? 'the override did not report an authorization'
        : `the advice was ${first.adviceShown || 'not usable'}, so there was no DENY to override`;
      if (first.overridden) throw new Error(state.reason);
      return { rows, state };
    }
    state.authorizationId = first.authorizationId;
    created.add(first.authorizationId);

    for (const item of base.repeats) {
      const repeat = keep(await reusedRequest({ item, officerDesk, quiet, authorizationId: first.authorizationId }), 'repeat');
      if (repeat.status === 'failed') throw new Error(`a repeat failed at ${repeat.stage}: ${repeat.error}`);
      if (!repeat.automatic) {
        await closeByAdvice({ client, watcher, auditor, auditorDesk, requestId: repeat.requestId, quiet });
        throw new Error('a repeat was not granted by the authorization; it was closed by following the advice');
      }
    }

    const nearMiss = await reviewed(base.nearMiss, 'nearMiss', 'follow');
    if (nearMiss.status !== 'decided') throw new Error(`the near miss failed at ${nearMiss.stage}: ${nearMiss.error}`);

    await quiet();
    const revoked = await client.post(`/access/dynamic-authorizations/${first.authorizationId}/revoke`, auditor, { reason: NOTE });
    state.revokeMs = round(revoked.ms);
    if (revoked.status !== 200) throw new Error(`the revocation failed: ${revoked.status} ${revoked.error}`);
    created.delete(first.authorizationId);

    const after = await reviewed(base.afterRevoke, 'afterRevoke', 'follow');
    if (after.status !== 'decided') throw new Error(`the request after revocation failed at ${after.stage}: ${after.error}`);
    state.status = 'done';
  } catch (error) {
    state.status = 'failed';
    state.error = String(error.message || error);
  }
  return { rows, state };
}

/**
 * Revoke what this run created and left active: the authorizations it noted, and any active one that one of
 * its own requests created (an override whose reply was lost). Never anything else.
 */
async function cleanUp({ client, auditor, created, requestIds }) {
  const checks = [];
  const revoke = async (authorizationId, why) => {
    try {
      const revoked = await client.post(`/access/dynamic-authorizations/${authorizationId}/revoke`, auditor, { reason: NOTE });
      checks.push({ name: `clean-up: ${why} is revoked`, ok: revoked.status === 200, detail: `${authorizationId} ${revoked.status}` });
    } catch (error) {
      checks.push({ name: `clean-up: ${why} is revoked`, ok: false, detail: `${authorizationId} ${error.message}` });
    }
  };
  for (const authorizationId of created) await revoke(authorizationId, 'an authorization this run left active');
  try {
    const active = await client.get('/access/dynamic-authorizations?status=active', auditor);
    for (const authorization of (active.status === 200 ? active.data : [])) {
      if (requestIds.has(authorization.originatingRequestId) && !created.has(authorization.authorizationId)) {
        await revoke(authorization.authorizationId, 'an authorization one of this run\'s requests created');
      }
    }
  } catch (error) {
    checks.push({ name: 'clean-up: the active authorizations can be read', ok: false, detail: error.message });
  }
  return checks;
}

async function verify({ client, auditor, rows }) {
  const log = await client.get(`/access/workflow-log?limit=${LOG_CAP}`, auditor);
  const entries = new Map((log.status === 200 ? log.data.entries : []).map((entry) => [entry.requestId, entry]));
  const authorizationOf = new Map(rows.filter((row) => row.kind === 'first').map((row) => [row.baseId, row.authorizationId]));
  for (const row of rows) {
    if (row.kind === 'repeat' && row.requestId && row.automatic) {
      const trail = await client.get(`/audit/request-trail/${row.requestId}`, auditor);
      row.checks = checkReuse({ trail: trail.data, entry: entries.get(row.requestId), authorizationId: authorizationOf.get(row.baseId) });
      row.ledgerOk = trail.status === 200 && row.checks.every((check) => check.ok);
      row.officerOk = row.officerSees === 'GRANTED' && row.explanationShown === false;
      row.status = row.ledgerOk && row.officerOk && row.reusedOk ? 'completed' : 'check-failed';
    } else if (row.status === 'decided') {
      await verifyReviewed({ client, row, auditor });
    }
  }
  return rows;
}

async function main() {
  const opts = options(process.argv.slice(2), ['plan', 'out', 'staging'], USAGE);
  const plan = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  if (digestOf(plan) !== plan.sha256) throw new Error('the plan does not match its own digest');
  const byId = new Map(plan.reuse.bases.map((base) => [base.id, base]));
  const bases = selected(plan.reuse.order.map((id) => byId.get(id)), opts);
  const auditor = plan.auditor;
  const run = openRun(opts.out);
  const client = createClient(API);
  const quiet = quietOn(opts.staging);
  const watcher = storeWatcher(path.dirname(opts.staging));
  await requireIdleHost(client, auditor);

  const desks = await openDesks({
    client, auditor, officers: [...new Set(bases.map((base) => base.username))],
    officerPhone: bases.some((base) => base.officer === 'phone'),
    auditorPhone: bases.some((base) => base.auditor === 'phone'),
  });
  const meta = {
    schema: 'dias-setup-reuse-run-v1', planSha256: plan.sha256, planned: bases.length, auditor,
    order: bases.map((base) => base.id), startedAtUtc: new Date().toISOString(), environment: environment(),
    staging: opts.staging, phoneSignInMs: desks.phoneSignInMs,
  };
  run.meta(meta);

  const rows = [];
  const states = [];
  const checks = [];
  const created = new Set();
  watcher.start();
  try {
    for (const base of bases) {
      const result = await runBase({ base, client, watcher, auditor, desks, quiet, created });
      result.rows.forEach((row) => { rows.push(row); run.append(row); });
      states.push(result.state);
      const repeats = result.rows.filter((row) => row.kind === 'repeat');
      console.log(`${base.id} ${result.state.status} authorization=${result.state.authorizationId || '-'} `
        + `repeats granted at once=${repeats.filter((row) => row.reusedOk).length}/${repeats.length}`
        + `${result.state.reason ? ` (${result.state.reason})` : ''}${result.state.error ? ` ERROR: ${result.state.error}` : ''}`);
      if (result.state.status === 'failed') {
        console.error('stopping: a step of the reuse experiment failed; read the requests before anything else is done');
        break;
      }
    }
  } finally {
    watcher.stop();
    // Only what this run created and did not revoke itself.
    checks.push(...await cleanUp({
      client, auditor, created, requestIds: new Set(rows.map((row) => row.requestId).filter(Boolean)),
    }));
    checks.push(...await desks.close());
  }

  await quiet();
  checks.push(...await eventsCheck({ client, auditor, rows, sinceUtc: meta.startedAtUtc, label: 'the reuse experiment' }));
  await verify({ client, auditor, rows });
  run.rewrite(rows);
  await quietOn(opts.staging, 30 * 60000)();
  checks.push(...await hostLeftIdle({ client, auditor }));
  checks.forEach((check) => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} (${check.detail})`));
  const done = states.filter((state) => state.status === 'done').length;
  const unverified = rows.filter((row) => row.status !== 'completed').length;
  run.meta({
    ...meta, finishedAtUtc: new Date().toISOString(), bases: states, done,
    notExercised: states.filter((state) => state.status === 'not-exercised').length,
    failed: states.filter((state) => state.status === 'failed').length, requests: rows.length, unverified, endChecks: checks,
  });
  console.log(`${done} of ${bases.length} reuse requests went through all five steps; ${rows.length - unverified} of ${rows.length} requests verified`);
  process.exitCode = states.every((state) => state.status !== 'failed') && unverified === 0
    && checks.every((check) => check.ok) ? 0 : 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { checkReuse, cleanUp };
