'use strict';

/** Read existing demo decisions; sensitive reads produce normal access logs. */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

async function main() {
  const [output, deniedId, allowedId, judgeOwnId, auditorOwnId, beforeFile] = process.argv.slice(2);
  if (!output || !deniedId || !allowedId) throw new Error('Provide a new output directory, denied ID, allowed ID and optional own-request IDs/baseline file');
  if (fs.existsSync(output)) throw new Error('Output already exists');
  fs.mkdirSync(output, { recursive: true });
  const base = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
  const checks = [];
  const tokens = new Map();
  const check = (name, fn) => { try { fn(); checks.push({ name, ok: true }); } catch (e) { checks.push({ name, ok: false, error: e.message }); } };
  const get = async (url, username) => {
    const r = await fetch(base + url, { headers: username ? { Authorization: 'Bearer ' + tokens.get(username) } : {}, signal: AbortSignal.timeout(30000) });
    return { status: r.status, ...(await r.json()) };
  };
  for (const username of ['insp.sharma', 'sp.north', 'judge.rana', 'dj.north']) {
    const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username }), signal: AbortSignal.timeout(30000) });
    const login = await r.json(); assert.ok(login.data?.token, 'login failed: ' + username); tokens.set(username, login.data.token);
  }
  const health = await get('/health'); check('backend reachable', () => assert.equal(health.success, true));
  const denied = await get('/access/request/' + deniedId + '/recommendation', 'insp.sharma');
  check('denied requester receives verified policy hints', () => { assert.equal(denied.status, 200); assert.equal(denied.data.counterfactuals.available, true); });
  check('written policy result is explicit and does not change the auditor decision', () => {
    assert.equal(denied.data.decision.decision, 'FORCE_DENY'); assert.ok(['ALLOW', 'DENY'].includes(denied.data.counterfactuals.writtenPolicy.result));
    if (denied.data.counterfactuals.writtenPolicy.result === 'ALLOW') assert.deepEqual(denied.data.counterfactuals.changeSets, []);
  });
  if (beforeFile) {
    const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')).data;
    check('LLM account and committed decision unchanged by the explanation component', () => {
      for (const field of ['reason', 'recommendation', 'reasonCode', 'policyRefs', 'decision', 'outcome']) assert.deepEqual(denied.data[field], before[field], field);
    });
  }
  const allowed = await get('/access/request/' + allowedId + '/recommendation', 'insp.sharma');
  check('allowed requester receives no policy hints', () => { assert.equal(allowed.status, 200); assert.equal(allowed.data.counterfactuals, null); });
  const audit = await get('/access/request/' + deniedId + '/recommendation', 'sp.north');
  check('auditor reading somebody else gets the same verified hints', () => { assert.equal(audit.status, 200); assert.deepEqual(audit.data.counterfactuals, denied.data.counterfactuals); });
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
    check('own denied request follows requester rules for ' + username, () => {
      assert.equal(own[username].status, 200); assert.equal(own[username].data.viewer, 'requester'); assert.equal(own[username].data.decision.decision, 'FORCE_DENY');
      assert.equal(own[username].data.counterfactuals.available, true);
    });
  }
  const results = { completedAt: new Date().toISOString(), base, checks, summary: {
    passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, total: checks.length,
  }, data: { denied, allowed, audit, forbidden, anonymous, invalid, own },
  limitations: ['Existing synthetic decisions only; no new access request, decision or grant submitted.',
    'Sensitive reads produce normal Fabric access-log writes.', 'Pending visibility, mismatches and feature toggle tested with unit fixtures.',
    'This does not measure LLM explanation accuracy, legal feasibility or testbed performance.'] };
  fs.writeFileSync(path.join(output, 'live.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'config.json'), JSON.stringify({ base, deniedId, allowedId, judgeOwnId, auditorOwnId, beforeFile }, null, 2) + '\n');
  console.log(JSON.stringify(results.summary)); if (results.summary.failed) process.exitCode = 1;
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
