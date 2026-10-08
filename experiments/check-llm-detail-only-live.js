'use strict';

/** Existing demo decisions only; sensitive reads append normal access-log events. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

async function main() {
  const [output, deniedId, allowedId, beforeFile, judgeOwnId, auditorOwnId] = process.argv.slice(2);
  if (!output || !deniedId || !allowedId || !beforeFile) {
    throw new Error('Provide a new output directory, denied ID, allowed ID, baseline file and optional own-request IDs');
  }
  if (fs.existsSync(output)) throw new Error('Output already exists');
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')).data;
  fs.mkdirSync(output, { recursive: true });
  const base = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
  const checks = [];
  const tokens = new Map();
  const check = (name, fn) => {
    try { fn(); checks.push({ name, ok: true }); }
    catch (error) { checks.push({ name, ok: false, error: error.message }); }
  };
  const get = async (url, username) => {
    const response = await fetch(base + url, {
      headers: username ? { Authorization: 'Bearer ' + tokens.get(username) } : {},
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, ...(await response.json()) };
  };
  for (const username of ['insp.sharma', 'sp.north', 'judge.rana', 'dj.north']) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }), signal: AbortSignal.timeout(30000),
    });
    const login = await response.json();
    assert.ok(login.data?.token, 'Demo login failed: ' + username);
    tokens.set(username, login.data.token);
  }
  const health = await get('/health');
  check('backend reachable', () => assert.equal(health.success, true));
  const denied = await get('/access/request/' + deniedId + '/recommendation', 'insp.sharma');
  check('denied requester retains the LLM explanation', () => {
    assert.equal(denied.status, 200);
    assert.equal(denied.data.reasonVisible, true);
    assert.equal(denied.data.available, true);
  });
  check('counterfactual response field removed', () => assert.equal(Object.hasOwn(denied.data, 'counterfactuals'), false));
  check('original LLM account and committed decision unchanged', () => {
    for (const field of ['reason', 'recommendation', 'reasonCode', 'policyRefs', 'missingEvidence',
      'reviewFlags', 'decision', 'outcome', 'explanationVisible', 'reasonVisible', 'available']) {
      assert.deepEqual(denied.data[field], before[field], field);
    }
  });
  const allowed = await get('/access/request/' + allowedId + '/recommendation', 'insp.sharma');
  check('allowed requester retains existing explanation withholding', () => {
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.explanationVisible, false);
    assert.equal(allowed.data.reason, null);
    assert.equal(Object.hasOwn(allowed.data, 'counterfactuals'), false);
  });
  const audit = await get('/access/request/' + deniedId + '/recommendation', 'sp.north');
  check('auditor retains the same LLM account without policy hints', () => {
    assert.equal(audit.status, 200);
    assert.equal(audit.data.viewer, 'auditor');
    assert.equal(audit.data.reason, before.reason);
    assert.equal(Object.hasOwn(audit.data, 'counterfactuals'), false);
  });
  const forbidden = await get('/access/request/' + deniedId + '/recommendation', 'judge.rana');
  check('other-organization reviewer is refused', () => assert.equal(forbidden.status, 403));
  const anonymous = await get('/access/request/' + deniedId + '/recommendation');
  check('anonymous caller is refused', () => assert.equal(anonymous.status, 401));
  const invalid = await get('/access/request/bad%21/recommendation', 'insp.sharma');
  check('invalid request identifier is refused', () => assert.equal(invalid.status, 400));
  const own = {};
  for (const [username, id] of [['judge.rana', judgeOwnId], ['dj.north', auditorOwnId]]) {
    if (!id) continue;
    own[username] = await get('/access/request/' + id + '/recommendation', username);
    check('own denied request retains requester visibility for ' + username, () => {
      assert.equal(own[username].status, 200);
      assert.equal(own[username].data.viewer, 'requester');
      assert.equal(own[username].data.decision.decision, 'FORCE_DENY');
      assert.equal(own[username].data.reasonVisible, true);
      assert.equal(Object.hasOwn(own[username].data, 'counterfactuals'), false);
    });
  }
  const results = { completedAt: new Date().toISOString(), base, checks, summary: {
    passed: checks.filter((item) => item.ok).length,
    failed: checks.filter((item) => !item.ok).length, total: checks.length,
  }, data: { denied, allowed, audit, forbidden, anonymous, invalid, own },
  limitations: ['Existing synthetic requests only; no new business request, decision or grant.',
    'Sensitive reads append normal Fabric access-log events.',
    'No LLM accuracy or end-to-end latency measurement.'] };
  fs.writeFileSync(path.join(output, 'live.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ base, deniedId, allowedId,
    beforeFile, judgeOwnId, auditorOwnId }, null, 2) + '\n');
  console.log(JSON.stringify(results.summary));
  if (results.summary.failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
