#!/usr/bin/env node
'use strict';

// Transport coverage experiment, not a model/performance benchmark. All fixture data is deterministic and
// synthetic.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'mobile-fixture-only-not-a-deployment-secret';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
const express = require('../backend/node_modules/express');
const jwt = require('../backend/node_modules/jsonwebtoken');
const { JWT_SECRET } = require('../backend/src/config');
const { createMobileRouter } = require('../backend/src/routes/mobile');

const output = path.resolve(process.argv[2] || 'experiments/runs/20261003_mobile_foundation');
const liveBase = process.argv[3];
const user = { username: 'mobile.fixture', org: 'police', fabricUser: 'mobile.fixture' };
const fixtures = Array.from({ length: 53 }, (_, i) => ({
  caseId: `CASE-${String(i).padStart(3, '0')}`, owningAgency: 'police',
  jurisdiction: 'North', status: 'open', assignedUsers: [],
})).reverse();

async function compare(base, token, dataset) {
  const headers = { Authorization: `Bearer ${token}` };
  const baseline = await fetch(`${base}/api/cases`, { headers }).then((r) => r.json());
  assert.equal(baseline.success, true, 'baseline case read must succeed');
  const expected = baseline.data.map((item) => item.caseId).sort();
  const received = [];
  const batchSizes = [];
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`${base}/api/mobile/cases?${query}`, { headers });
    assert.equal(response.status, 200, 'batch route must succeed');
    const page = (await response.json()).data;
    assert.ok(page.items.length <= 20);
    batchSizes.push(page.items.length);
    received.push(...page.items.map((item) => item.caseId));
    cursor = page.nextCursor;
    assert.ok(batchSizes.length <= 100, 'page cap');
  } while (cursor);
  assert.deepEqual(received, expected);
  assert.equal(new Set(received).size, expected.length);
  return {
    dataset, baseline: { requests: 1, rows: expected.length, maxRowsPerResponse: expected.length },
    batched: { requests: batchSizes.length, rows: received.length,
      maxRowsPerResponse: Math.max(...batchSizes), batchSizes, exactCoverage: true },
    noBatchAblation: { requests: 1, maxRowsPerResponse: expected.length },
  };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const app = express();
  app.get('/api/cases', (_req, res) => res.json({ success: true, data: fixtures, error: null }));
  app.use('/api/mobile', createMobileRouter({ evaluate: async () => fixtures }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const results = [];
  try {
    results.push(await compare(`http://127.0.0.1:${server.address().port}`,
      jwt.sign(user, JWT_SECRET), 'deterministic_synthetic_53_cases'));
    if (liveBase) {
      const username = process.env.MOBILE_TEST_USER || 'insp.sharma';
      const response = await fetch(`${liveBase}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      }).then((r) => r.json());
      assert.equal(response.success, true, 'live demo identity login');
      results.push(await compare(liveBase, response.data.token, 'live_local_Fabric_cases'));
    }
    fs.writeFileSync(path.join(output, 'transport-results.json'), JSON.stringify({
      completedAt: new Date().toISOString(), results,
      limitations: ['Counts are functional checks, not latency or throughput measurements.',
        'The host reads the complete QueryCases result for every page.',
        'Offline cache ablation is exercised separately on Android with real SQLite.'],
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'transport-config.json'), JSON.stringify({
      fixtureRows: 53, pageSize: 20, seed: 0, randomness: 'none',
      liveBase: liveBase || null, node: process.version,
    }, null, 2) + '\n');
    const table = ['dataset,variant,requests,rows,max_rows_per_response,exact_coverage'];
    for (const result of results) {
      for (const [variant, metrics] of [['baseline', result.baseline], ['batched', result.batched]]) {
        table.push([result.dataset, variant, metrics.requests, metrics.rows,
          metrics.maxRowsPerResponse, variant === 'batched' ? metrics.exactCoverage : ''].join(','));
      }
    }
    const tables = path.resolve('results/tables');
    fs.mkdirSync(tables, { recursive: true });
    // Version the comparison with the run directory so later runs retain evidence.
    fs.writeFileSync(path.join(tables, `${path.basename(output)}_transport.csv`), table.join('\n') + '\n');
    console.log(JSON.stringify(results, null, 2));
  } finally { await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
