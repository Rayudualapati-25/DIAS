#!/usr/bin/env node
'use strict';

/**
 * Run every live DIAS acceptance scenario and write the evidence.
 *
 * The live listener must be STOPPED before this runs: scenarios I–L answer
 * requests themselves, with deliberately broken or duplicated deliveries, and a
 * second listener racing them would decide which of the two answered first.
 * The runner refuses to start if it sees the listener holding the stream.
 *
 *   CHAINCODE=diasrecords node scripts/dias/run-live-scenarios.js --out <dir>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const fabric = require('../../backend/src/fabric/gateway');
const config = require('../../backend/src/config');
const core = require('./scenarios-core');
const failure = require('./scenarios-failure');
const { setAnswerer, writeReport } = require('./live-scenarios');

const MODEL_URL = process.env.DIAS_MODEL_URL || config.DIAS_MODEL_URL;

function listenerRunning() {
  try {
    return execSync('pgrep -f "ai/start.js" || true', { encoding: 'utf8' }).trim().length > 0;
  } catch {
    return false;
  }
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1]
    : 'experiments/runs/20260912_dias_live_fabric');
  if (listenerRunning()) {
    throw new Error('the DIAS listener is running; stop it before running the scenarios '
      + '(scenarios I-L answer requests themselves and must not race a second answerer)');
  }

  const results = [];
  const record = (result) => {
    results.push(result);
    const failed = result.checks.filter((c) => !c.ok);
    console.log(`${result.status === 'PASS' ? 'PASS' : 'FAIL'}  ${result.id}  ${result.title}`);
    for (const c of failed) console.log(`      x ${c.name}: ${c.detail}`);
  };

  // This process is the only answerer for the whole run, so scenarios I-L can
  // control exactly how a delivery fails without racing a background listener.
  setAnswerer((requestId) => failure.answerWith(requestId, MODEL_URL));

  record(await core.scenarioA());
  record(await core.scenarioB());

  const c = await core.scenarioC();
  record(c.result);
  if (c.authorization) {
    record(await core.scenarioD(c.authorization.authorizationId));
    record(await core.scenarioE(c.authorization.authorizationId));
    record(await core.scenarioF(c.authorization.authorizationId));
  }
  record(await core.scenarioG());
  record(await core.scenarioH());

  // I-L each need a freshly committed, unanswered request.
  const pendingFor = (label) => failure.submitWithoutAnswer(core.CROSS_DISTRICT, {
    justification: `Cross-district enquiry, reference ${label}.`,
  });
  record(await failure.scenarioI(await pendingFor('I')));
  record(await failure.scenarioJ(await pendingFor('J')));
  record(await failure.scenarioK(await pendingFor('K'), MODEL_URL));
  record(await failure.scenarioL(await pendingFor('L'), MODEL_URL));
  record(await failure.scenarioM());
  record(await failure.scenarioN(await pendingFor('N')));

  const forO = await pendingFor('O');
  await failure.answerWith(forO.requestId, MODEL_URL);
  record(await failure.scenarioO({ ...forO, recordId: core.CROSS_DISTRICT.recordId }));

  const passed = results.filter((r) => r.status === 'PASS').length;
  writeReport(outDir, {
    chaincode: config.CHAINCODE,
    channel: config.CHANNEL,
    modelEndpoint: MODEL_URL,
    ranAtUtc: new Date().toISOString(),
    scenariosRun: results.length,
    passed,
    failed: results.length - passed,
    results,
  });
  console.log(`\n${passed}/${results.length} scenarios passed; evidence in ${outDir}/scenarios.json`);
  if (passed !== results.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(`[scenarios] ${error.stack || error.message}`);
  process.exit(1);
});
