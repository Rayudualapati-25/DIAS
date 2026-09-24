#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(
  ROOT,
  'experiments',
  'runs',
  '20260902_standalone_extraction',
  'live_decision_smoke.json'
);
const URL = process.env.LLMXAI_APP_URL || 'http://127.0.0.1:3002';

const cases = [
  {
    name: 'allow-active-assigned-investigator',
    expected: 'allow',
    request: {
      profileId: 'user-sharma',
      recordId: 'REC-FIR-001',
      query: 'May I view the FIR for the active investigation?',
    },
  },
  {
    name: 'deny-suspended-credential',
    expected: 'deny',
    request: {
      profileId: 'user-rathore',
      recordId: 'REC-FIR-001',
      query: 'Please view the FIR for the active investigation.',
    },
  },
  {
    name: 'escalate-cross-jurisdiction',
    expected: 'escalate',
    request: {
      profileId: 'user-singh',
      recordId: 'REC-FIR-001',
      query: 'May I view this FIR for investigation?',
    },
  },
];

// Identity now comes from the signed-in session, so each case signs in as its
// own officer and reuses that session cookie for the decision request.
async function signIn(profileId) {
  const response = await fetch(`${URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) throw new Error(`Sign in failed for ${profileId}: HTTP ${response.status}.`);
  const cookie = response.headers.get('set-cookie');
  if (!cookie) throw new Error(`No session cookie was issued for ${profileId}.`);
  return cookie.split(';')[0];
}

async function main() {
  const healthResponse = await fetch(`${URL}/api/health`);
  const health = await healthResponse.json();
  const rows = [];
  for (const testCase of cases) {
    const { profileId, ...decisionBody } = testCase.request;
    const cookie = await signIn(profileId);
    const response = await fetch(`${URL}/api/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(decisionBody),
    });
    const body = await response.json();
    rows.push({
      name: testCase.name,
      signedInAs: profileId,
      expected: testCase.expected,
      status: response.status,
      actual: body.result?.decision || body.safetyDecision || null,
      reasonCode: body.result?.reasonCode || null,
      decisionSource: body.result?.decisionSource || null,
      modelOutputConsistent: body.result?.modelOutputConsistent ?? null,
      latencyMs: body.evidence?.latencyMs || null,
      passed: response.ok && body.result?.decision === testCase.expected,
      response: body,
    });
  }
  const report = {
    createdAtUtc: new Date().toISOString(),
    interfaceUrl: URL,
    health,
    status: health.ready && rows.every((row) => row.passed) ? 'passed' : 'failed',
    cases: rows,
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: path.relative(ROOT, OUTPUT),
    status: report.status,
    cases: rows.map(({ response, ...row }) => row),
  }, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
