#!/usr/bin/env node
'use strict';

/**
 * Determinism check for the live-run errors: were they caused by load?
 *
 * For every E5 workflow whose recommendation disagreed with the written policy,
 * this replays the exact stored prompt inputs (the committed verified request
 * and the justification) through the same recommender code and model server,
 * one at a time with no other load, and compares the answer with the one given
 * under load: decision, reason code and the hash of the raw model output.
 *
 * Usage: node testbed/load/replay-errors.js --rows /results/<e5>/requests.jsonl \
 *          --out /results/<e5>/replay-errors.json
 */

const fs = require('fs');
const path = require('path');

const APP = path.resolve(__dirname, '..', '..');
const { getDiasRuntime } = require(path.join(APP, 'backend/src/dias/runtime'));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i += 1; }
  }
  return out;
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.rows || !opts.out) throw new Error('--rows and --out are required');
  if (fs.existsSync(opts.out)) throw new Error('replay output exists; retain the earlier evidence');
  const rows = fs.readFileSync(opts.rows, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const wrong = rows.filter((row) => row.phase === 'measured' && row.validRecommendation && !row.correct);
  if (opts['review-dir']) {
    throw new Error('set DIAS_REVIEW_STORE_DIR and the existing encryption keys; --review-dir plaintext reads are retired');
  }
  const { recommender, store } = getDiasRuntime();
  const results = [];
  for (const row of wrong) {
    const entry = store.read(row.requestId);
    if (!entry) throw new Error(`missing encrypted review ${row.requestId}`);
    const underLoad = entry.recommendation;
    const replay = await recommender.recommend({
      requestId: `${row.requestId}-replay`,
      verifiedRequest: entry.verifiedRequest,
      justification: entry.justification,
      requesterClaims: entry.requesterClaims,
    });
    const alone = replay.recommendation || {};
    if (replay.generationStatus !== 'OK') throw new Error(`replay ${row.requestId}: ${replay.generationStatus}`);
    const provenance = ['modelId', 'baseModelRevision', 'adapterHash', 'promptVersion', 'policyBundleHash'];
    for (const field of provenance) {
      if (underLoad.provenance[field] !== replay.provenance[field]) {
        throw new Error(`replay ${row.requestId}: ${field} differs; this is not a determinism check`);
      }
    }
    results.push({
      requestId: row.requestId,
      level: row.level,
      expected: row.expected,
      underLoad: { recommendation: underLoad.recommendation, reasonCode: underLoad.reasonCode,
        rawOutputHash: underLoad.provenance.rawOutputHash, inferenceMs: underLoad.provenance.latencyMs.inference },
      alone: { recommendation: alone.recommendation, reasonCode: alone.reason_code,
        rawOutputHash: replay.provenance.rawOutputHash, inferenceMs: replay.provenance.latencyMs.inference },
      sameDecision: alone.recommendation === underLoad.recommendation,
      sameReason: alone.reason_code === underLoad.reasonCode,
      identicalOutput: replay.provenance.rawOutputHash === underLoad.provenance.rawOutputHash,
    });
    process.stdout.write(`${row.requestId}: load ${underLoad.recommendation}/${underLoad.reasonCode} alone ${alone.recommendation}/${alone.reason_code}\n`);
  }
  const summary = {
    replayed: results.length,
    sameDecision: results.filter((r) => r.sameDecision).length,
    sameReason: results.filter((r) => r.sameReason).length,
    identicalOutput: results.filter((r) => r.identicalOutput).length,
    results,
  };
  fs.writeFileSync(opts.out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ replayed: summary.replayed, sameDecision: summary.sameDecision,
    sameReason: summary.sameReason, identicalOutput: summary.identicalOutput }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
