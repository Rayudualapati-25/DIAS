'use strict';

/**
 * Entry point for the DIAS recommendation service.
 *
 * Run it as its own process so the API server and the model listener fail
 * independently: an unreachable model must not take the auditor interface down
 * with it, and a restart of either must not lose a committed request.
 */

const fabric = require('../fabric/gateway');
const { createDiasRuntime } = require('../dias/runtime');
const { run } = require('../dias/recommendationService');

const runtime = createDiasRuntime();

run({
  fabric,
  recommenderFor: runtime.recommenderFor,
  signer: runtime.signer,
  policyBundleHash: runtime.policyBundleHash,
  checkpoint: runtime.checkpoint,
}).catch((error) => {
  console.error(`[dias] recommendation service stopped: ${error.message}`);
  process.exit(1);
});
