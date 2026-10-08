#!/usr/bin/env node
'use strict';
// Testbed preflight: wait through signing AND ledger commitment, rather than
// using recommendation.ready trace events (which only finish model generation).
const { createClient, createWatcher } = require('./workflow');
async function main() {
  const client = createClient(process.env.DIAS_API_URL || 'http://dias-backend:3001/api');
  const pending = await client.pending('sp.north');
  if (pending.status !== 200 || !Array.isArray(pending.data)) throw new Error('cannot list pending requests');
  const ids = [...new Set(pending.data.map(item => item.request.requestId))];
  const watcher = createWatcher(client);
  await Promise.all(ids.map(id => watcher.wait(id, 300000, 'sp.north')));
  console.log(JSON.stringify({ pendingRequestsObserved: ids.length, preparing: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
