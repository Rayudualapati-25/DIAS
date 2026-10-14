#!/usr/bin/env node
'use strict';

/** The 100 officers of the 100-user experiment. */

const fs = require('fs');

/** Enrolled officers on the Mac network on 2026-10-14 (GET /api/users), and how many copies each gets. */
const TEMPLATES = Object.freeze([
  { template: 'io.krishnan', copies: 18, org: 'police', role: 'investigating-officer', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', caseAssignments: ['CASE-2026-001'] },
  { template: 'insp.sharma', copies: 16, org: 'police', role: 'inspector', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', caseAssignments: ['CASE-2026-001', 'CASE-2026-002'] },
  { template: 'const.verma', copies: 10, org: 'police', role: 'constable', rank: '1', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'low', caseAssignments: [] },
  { template: 'sho.reddy', copies: 8, org: 'police', role: 'inspector', rank: '3', station: 'PS-Central', jurisdiction: 'district-north', clearance: 'high', caseAssignments: [] },
  { template: 'insp.singh', copies: 6, org: 'police', role: 'inspector', rank: '3', station: 'PS-South', jurisdiction: 'district-south', clearance: 'high', caseAssignments: ['CASE-2026-001'] },
  { template: 'analyst.rao', copies: 8, org: 'forensics', role: 'lab-analyst', station: 'FSL-North', jurisdiction: 'district-north', clearance: 'medium', caseAssignments: ['CASE-2026-001'] },
  { template: 'dir.iyer', copies: 6, org: 'forensics', role: 'lab-director', station: 'FSL-North', jurisdiction: 'district-north', clearance: 'high', caseAssignments: [] },
  { template: 'pp.mehta', copies: 6, org: 'prosecution', role: 'public-prosecutor', jurisdiction: 'district-north', clearance: 'high', caseAssignments: [] },
  { template: 'dc.nair', copies: 6, org: 'prosecution', role: 'defense-counsel', jurisdiction: 'district-north', clearance: 'low', caseAssignments: [] },
  { template: 'judge.rana', copies: 10, org: 'court', role: 'judge', jurisdiction: 'district-north', clearance: 'high', caseAssignments: [] },
  { template: 'clerk.das', copies: 6, org: 'court', role: 'court-clerk', jurisdiction: 'district-north', clearance: 'low', caseAssignments: [] },
]);

/** The 100 officers, in a fixed order: `lt.<org>.<nn>`, numbered per organization. */
function officers() {
  const numbers = {};
  return TEMPLATES.flatMap(({ copies, ...profile }) => Array.from({ length: copies }, () => {
    numbers[profile.org] = (numbers[profile.org] || 0) + 1;
    const number = String(numbers[profile.org]).padStart(2, '0');
    return {
      ...profile,
      username: `lt.${profile.org}.${number}`,
      displayName: `Load-test ${profile.role} ${profile.org} ${number}`,
      badgeId: `LT-${profile.org.slice(0, 3).toUpperCase()}-${number}`,
    };
  }));
}

/** The registration body the API takes (`POST /api/users`). */
function registration(officer) {
  return {
    username: officer.username, displayName: officer.displayName, org: officer.org, role: officer.role,
    ...(officer.rank ? { rank: officer.rank } : {}), ...(officer.station ? { station: officer.station } : {}),
    jurisdiction: officer.jurisdiction, badgeId: officer.badgeId, clearance: officer.clearance,
    ...(officer.caseAssignments.length ? { caseAssignments: officer.caseAssignments.join('|') } : {}),
  };
}

async function register(out) {
  const { createClient } = require('./lib');
  const client = createClient(process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api');
  const existing = await client.get('/users', 'sp.north');
  if (existing.status !== 200) throw new Error(`the user list could not be read: ${existing.status}`);
  const known = new Set(existing.data.map((user) => user.userId || user.username));
  const report = { startedAtUtc: new Date().toISOString(), registeredBy: 'sp.north', officers: [] };
  for (const officer of officers()) {
    if (known.has(officer.username)) {
      report.officers.push({ username: officer.username, status: 'already enrolled' });
      continue;
    }
    const created = await client.post('/users', 'sp.north', registration(officer));
    report.officers.push({ username: officer.username, template: officer.template, httpStatus: created.status,
      status: created.status === 201 ? 'registered' : `failed: ${created.error}`, ms: Math.round(created.ms) });
    console.log(`${officer.username} ${created.status} ${created.status === 201 ? '' : created.error}`);
    if (created.status !== 201) break;
  }
  // Every new officer must be able to sign in: that proves the certificate and the ledger profile agree.
  for (const entry of report.officers.filter((item) => item.status === 'registered' || item.status === 'already enrolled')) {
    try { await client.login(entry.username); entry.signIn = 'ok'; } catch (error) { entry.signIn = error.message; }
  }
  report.finishedAtUtc = new Date().toISOString();
  report.registered = report.officers.filter((item) => item.status === 'registered').length;
  report.signInOk = report.officers.filter((item) => item.signIn === 'ok').length;
  fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`${report.registered} registered now, ${report.signInOk} of ${report.officers.length} sign in`);
  process.exitCode = report.signInOk === 100 ? 0 : 1;
}

module.exports = { TEMPLATES, officers, registration };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    officers().forEach((officer) => console.log(JSON.stringify(registration(officer))));
  } else if (argv.includes('--register')) {
    const out = argv[argv.indexOf('--out') + 1];
    if (!out || argv.indexOf('--out') === -1) throw new Error('usage: users100.js --register --out FILE');
    register(out).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } else {
    console.log('usage: users100.js --list | --register --out FILE');
  }
}
