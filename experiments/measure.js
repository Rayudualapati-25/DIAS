'use strict';

/**
 * Reproducible live comparison of a role-only baseline with the contextual
 * SEBA-XAI policy. No deliberate database/file corruption endpoint is used.
 *
 * Prerequisites: make all; make backend
 * Output: timestamped JSON and Markdown under experiments/results/.
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OUT_DIR = path.resolve(__dirname, 'results');

async function api(method, urlPath, { token, body } = {}) {
  const started = process.hrtime.bigint();
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  return {
    status: response.status,
    ok: json.success,
    data: json.data,
    error: json.error,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

async function login(username) {
  const result = await api('POST', '/auth/login', { body: { username } });
  if (!result.ok) throw new Error(`login ${username}: ${result.error}`);
  return result.data.token;
}

// Ablation: remove assignment, jurisdiction, protection, credential-state and
// purpose checks. If the role has a generic view capability, return ALLOW.
function roleOnlyBaseline(role) {
  const viewRoles = new Set([
    'constable', 'sub-inspector', 'inspector', 'sho', 'investigating-officer',
    'lab-analyst', 'lab-director', 'public-prosecutor', 'defense-counsel',
    'judge', 'magistrate', 'court-clerk', 'auditor', 'ombudsman',
  ]);
  return viewRoles.has(role) ? 'allow' : 'deny';
}

async function request(token, recordId, purpose) {
  const result = await api('POST', '/access/request', {
    token,
    body: { recordId, action: 'view', purpose },
  });
  if (!result.ok) throw new Error(`request ${recordId}: ${result.error}`);
  return result;
}

async function main() {
  const tokens = {};
  for (const user of [
    'io.krishnan', 'const.verma', 'analyst.rao', 'insp.singh',
    'insp.sharma', 'judge.rana', 'insp.rathore', 'aud.qureshi',
  ]) tokens[user] = await login(user);

  const definitions = [
    { id: 1, user: 'io.krishnan', role: 'investigating-officer', record: 'REC-FIR-001', purpose: 'investigation', expected: 'allow' },
    { id: 2, user: 'const.verma', role: 'constable', record: 'REC-FIR-001', purpose: 'investigation', expected: 'deny' },
    { id: 3, user: 'analyst.rao', role: 'lab-analyst', record: 'REC-EVIDENCE-001', purpose: 'forensic-analysis', expected: 'deny' },
    { id: 4, user: 'insp.singh', role: 'inspector', record: 'REC-FIR-001', purpose: 'investigation', expected: 'escalate' },
    { id: 5, user: 'insp.sharma', role: 'inspector', record: 'REC-JUVENILE-001', purpose: 'investigation', expected: 'deny' },
    { id: 7, user: 'insp.rathore', role: 'inspector', record: 'REC-FIR-001', purpose: 'investigation', expected: 'deny' },
    { id: 8, user: 'aud.qureshi', role: 'auditor', record: 'REC-FIR-001', purpose: 'audit-review', expected: 'deny' },
  ];

  const rows = [];
  let escalation;
  for (const item of definitions) {
    const result = await request(tokens[item.user], item.record, item.purpose);
    const actual = result.data.decision;
    rows.push({
      ...item,
      baseline: roleOnlyBaseline(item.role),
      actual,
      reasonCode: result.data.explanation.reasonCode,
      policyVersion: result.data.policyVersion,
      decisionId: result.data.decisionId,
      commitLatencyMs: Number(result.elapsedMs.toFixed(2)),
    });
    if (item.id === 4) escalation = result.data;
  }

  const approval = await api(
    'POST', `/access/REC-FIR-001/${escalation.decisionId}/approve`, {
      token: tokens['judge.rana'], body: { note: 'deterministic measurement approval' },
    }
  );
  if (!approval.ok) throw new Error(`approval: ${approval.error}`);
  rows.splice(5, 0, {
    id: 6,
    user: 'insp.singh',
    role: 'inspector',
    record: 'REC-FIR-001',
    purpose: 'investigation',
    expected: 'approved-after-escalation',
    baseline: 'allow-without-approval',
    actual: approval.data.status,
    reasonCode: escalation.explanation.reasonCode,
    policyVersion: escalation.policyVersion,
    decisionId: escalation.decisionId,
    approvalLatencyMs: Number(approval.elapsedMs.toFixed(2)),
  });

  const liveCorrect = rows.filter((row) => row.actual === row.expected).length;
  const baselineCorrect = rows.filter((row) => row.baseline === row.expected).length;

  const decisionOne = rows.find((row) => row.id === 1);
  const decisionList = await api('GET', `/access/record/${decisionOne.record}`, {
    token: tokens['aud.qureshi'],
  });
  const decisionArtifact = decisionList.data.find(
    (item) => item.decisionId === decisionOne.decisionId
  );
  const forged = await api(
    'POST', `/audit/verify-explanation/${decisionOne.record}/${decisionOne.decisionId}`, {
      token: tokens['aud.qureshi'],
      body: { artifact: { ...decisionArtifact.explanation, reasonCode: 'FORGED' } },
    }
  );
  const metadata = await api('GET', '/records/REC-EVIDENCE-001', {
    token: tokens['aud.qureshi'],
  });

  const report = {
    generatedAtUtc: new Date().toISOString(),
    environment: {
      channel: 'crimechannel',
      chaincode: 'crimerecords 2.3',
      organizations: 5,
      deployment: 'single-host local Docker/Colima; not a distributed benchmark',
    },
    workload: 'eight deterministic synthetic governance scenarios',
    baseline: {
      name: 'role-only access ablation',
      removedComponents: [
        'credential state', 'case assignment', 'jurisdiction',
        'record protection flags', 'purpose', 'supervisor approval',
      ],
      correct: baselineCorrect,
      total: rows.length,
      accuracy: baselineCorrect / rows.length,
      interpretation: 'Only this fixed synthetic workload is measured.',
    },
    proposed: {
      name: 'contextual Fabric RBAC+ABAC+PBAC policy',
      correct: liveCorrect,
      total: rows.length,
      accuracy: liveCorrect / rows.length,
    },
    scenarios: rows,
    integrityChecks: {
      forgedExplanationDetected: forged.ok && forged.data.match === false,
      rawVictimContentAbsentFromLedgerMetadata:
        metadata.ok && !JSON.stringify(metadata.data).includes('REDACTED-DEMO'),
      metadataContainsContentCommitment:
        metadata.ok && /^[0-9a-f]{64}$/.test(metadata.data.contentHash || ''),
    },
    limitations: [
      'Results use synthetic data and deterministic policy fixtures.',
      'Latency is client-observed on one computer and includes the orderer batch wait.',
      'The baseline is an ablation for this workload, not a published competing system.',
      'No production security, legal compliance, or CCTNS/ICJS integration is claimed.',
    ],
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = report.generatedAtUtc.replace(/[:.]/g, '-');
  const base = `seba_xai_contextual_run_${stamp}`;
  const jsonPath = path.join(OUT_DIR, `${base}.json`);
  const mdPath = path.join(OUT_DIR, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    '# SEBA-XAI contextual-policy run',
    '',
    `Generated: ${report.generatedAtUtc}`,
    '',
    '| Scenario | Expected | Role-only ablation | Contextual Fabric | Reason | Commit ms |',
    '|---:|---|---|---|---|---:|',
    ...rows.map((row) => `| ${row.id} | ${row.expected} | ${row.baseline} | ${row.actual} | ${row.reasonCode} | ${row.commitLatencyMs || row.approvalLatencyMs} |`),
    '',
    `Role-only ablation: ${baselineCorrect}/${rows.length} correct on this fixed workload.`,
    `Contextual policy: ${liveCorrect}/${rows.length} correct on this fixed workload.`,
    '',
    'These are prototype scenario checks, not statistical evidence of real-world effectiveness.',
  ].join('\n');
  fs.writeFileSync(mdPath, `${markdown}\n`);
  console.log(`wrote ${jsonPath}`);
  console.log(`wrote ${mdPath}`);
  console.log(`role-only ${baselineCorrect}/${rows.length}; contextual ${liveCorrect}/${rows.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
