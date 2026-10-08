#!/usr/bin/env node
'use strict';

/**
 * Close every request still waiting for an auditor, the way the load generator
 * does (the decision follows the stored recommendation), so an aborted run
 * leaves nothing pending on the ledger. Waits for recommendations still being
 * prepared.
 *
 * Usage: node testbed/load/close-pending.js --url http://dias-backend:3001/api
 */

const { createClient, sleep, auditorFor } = require('./workflow');

async function main() {
  const url = process.argv[process.argv.indexOf('--url') + 1] || 'http://dias-backend:3001/api';
  const client = createClient(url);
  let closed = 0;
  for (let round = 0; round < 60; round += 1) {
    const pending = await client.pending('sp.north');
    if (pending.status !== 200) throw new Error(`pending list: ${pending.status} ${pending.error}`);
    if (pending.data.length === 0) break;
    for (const item of pending.data) {
      const requestId = item.request.requestId;
      if (['pending', 'signed'].includes(item.recommendationState)) continue;
      const auditor = auditorFor(item.request, item.request.requester || {});
      if (item.commitment && (!item.integrity || item.integrity.status !== 'verified')) {
        throw new Error(`cannot close ${requestId}: recommendation integrity is not verified`);
      }
      const rec = item.recommendation || {};
      const valid = item.recommendationState === 'committed' && rec.generationStatus === 'OK' && ['ALLOW', 'DENY'].includes(rec.recommendation);
      const body = valid
        ? { decision: rec.recommendation === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY' }
        : { decision: 'FORCE_DENY', reason: 'Closed after an aborted test run; no valid recommendation.' };
      const decided = await client.decide(requestId, auditor, body);
      process.stdout.write(`${requestId}: ${decided.status}\n`);
      if (decided.status === 201) closed += 1;
    }
    await sleep(5000);
  }
  const left = await client.pending('sp.north');
  console.log(JSON.stringify({ closed, stillPending: left.data ? left.data.length : null }));
  if (left.status !== 200 || !Array.isArray(left.data) || left.data.length !== 0) {
    throw new Error('testbed requests remain pending; the next experiment must not start');
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
