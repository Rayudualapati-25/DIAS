#!/usr/bin/env node
'use strict';

/**
 * Deterministic audit-field completeness check over a retained live acceptance
 * run. This does not impersonate an independent human evaluator: it measures
 * whether the deployed API and retained off-chain review can mechanically
 * reconstruct the facts the paper says are recorded.
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('../../scripts/dias/acceptance-client');

const REPO = path.resolve(__dirname, '..', '..');

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function present(value) {
  return value !== null && value !== undefined && value !== '';
}

function getScenario(acceptance, id) {
  const item = acceptance.scenarios.find((scenario) => scenario.id === id);
  if (!item) throw new Error(`acceptance scenario ${id} not found`);
  return item;
}

function readReview(dirs, requestId) {
  for (const dir of dirs) {
    const file = path.join(dir, `${requestId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function checksFor(type, trail, review, sourceTrail) {
  const common = {
    requester: present(trail.request?.requester?.username),
    record: present(trail.request?.recordId),
    action: present(trail.request?.action),
    purpose: present(trail.request?.purpose),
    verifiedContext: present(trail.request?.verifiedRequestHash) && present(trail.request?.verifiedRequest),
    outcome: present(trail.accessOutcome?.outcome) && present(trail.accessOutcome?.basis),
    transactionProvenance: Array.isArray(trail.transactions) && trail.transactions.length > 0,
  };
  if (type === 'automatic-reuse') {
    return {
      ...common,
      reuseAuthorization: present(trail.accessOutcome?.authorizationId),
      originatingRequest: present(trail.accessOutcome?.originatingRequestId),
      originatingAuditorDecision: present(trail.accessOutcome?.originatingAuditorDecisionId),
      originalApprovalResolvable: present(sourceTrail?.auditorDecision?.decision),
      originalOverrideReason: present(sourceTrail?.offChainReview?.auditorNote?.reason),
    };
  }
  const recommendation = review?.recommendation;
  const auditorNote = review?.auditorNote;
  const base = {
    ...common,
    generationStatus: present(recommendation?.generationStatus),
    auditorDecision: present(trail.auditorDecision?.decision),
    llmAgreement: present(trail.auditorDecision?.llmAgreement),
    auditorIdentity: present(trail.auditorDecision?.auditor?.username),
  };
  if (type === 'model-unavailable') {
    return {
      ...base,
      modelFailureCode: recommendation?.generationStatus === 'UNAVAILABLE'
        && present(recommendation?.errorCode),
      humanReason: present(auditorNote?.reason),
    };
  }
  return {
    ...base,
    modelRecommendation: present(recommendation?.recommendation),
    reasonCode: present(recommendation?.reasonCode),
    policyClauses: Array.isArray(recommendation?.policyRefs) && recommendation.policyRefs.length > 0,
    adapterProvenance: present(recommendation?.provenance?.adapterHash),
    overrideReason: trail.auditorDecision?.llmAgreement === 'AGREED' || present(auditorNote?.reason),
    authorizationCreation: trail.auditorDecision?.authorizationCreated === false
      || present(trail.auditorDecision?.createdAuthorizationId),
  };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const apiUrl = args.url || 'http://127.0.0.1:3001/api';
  const acceptanceFile = path.resolve(args.acceptance || '');
  const reviewDirs = String(args['review-dirs'] || '').split(',').filter(Boolean).map((dir) => path.resolve(dir));
  const outDir = path.resolve(REPO, args.out || 'experiments/runs/20260916_dias_audit_reconstruction');
  if (!args.acceptance || reviewDirs.length === 0) {
    throw new Error('--acceptance and --review-dirs are required');
  }
  if (fs.existsSync(path.join(outDir, 'audit-reconstruction.json'))) {
    throw new Error(`${path.relative(REPO, outDir)} already contains a completed run`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const acceptance = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
  const client = createClient(apiUrl);
  await client.token('sp.north');

  const ids = {
    normalAllow: getScenario(acceptance, 'R3').evidence.requestId,
    normalDeny: getScenario(acceptance, 'R7').evidence.requests[0].requestId,
    overrideDeny: getScenario(acceptance, 'R4').evidence.requestId,
    automaticReuse: getScenario(acceptance, 'R5').evidence.requestId,
    modelUnavailable: getScenario(acceptance, 'R12').evidence.requestId,
  };

  // Locate the acceptance requests that observed revocation and expiry; the R9
  // summary retains authorization IDs while the trail retains the exact request.
  const allTrails = [];
  for (const requestId of acceptance.requestIds) {
    const result = await client.trail(requestId);
    if (result.status === 200) allTrails.push(result.data);
  }
  const byOutcome = (outcome) => allTrails.find(
    (trail) => trail.request?.dynamicAuthorizationCheck?.outcome === outcome
  );
  ids.revokedAuthorization = byOutcome('REVOKED')?.requestId;
  ids.expiredAuthorization = byOutcome('EXPIRED')?.requestId;

  const cases = [
    ['normal-policy-allow', 'model-reviewed', ids.normalAllow],
    ['normal-policy-deny', 'model-reviewed', ids.normalDeny],
    ['auditor-override-model-deny', 'model-reviewed', ids.overrideDeny],
    ['automatic-authorization-reuse', 'automatic-reuse', ids.automaticReuse],
    ['revoked-authorization-observed', 'model-reviewed', ids.revokedAuthorization],
    ['expired-authorization-observed', 'model-reviewed', ids.expiredAuthorization],
    ['model-unavailable-human-decision', 'model-unavailable', ids.modelUnavailable],
  ];

  const reconstructed = [];
  for (const [name, type, requestId] of cases) {
    if (!requestId) {
      reconstructed.push({ name, type, requestId: null, queryMs: null, checks: { requestLocated: false } });
      continue;
    }
    const started = performance.now();
    const response = await client.trail(requestId);
    const queryMs = Number((performance.now() - started).toFixed(3));
    if (response.status !== 200) {
      reconstructed.push({ name, type, requestId, queryMs, checks: { trailReadable: false }, error: response.error });
      continue;
    }
    const trail = response.data;
    const review = trail.offChainReview || readReview(reviewDirs, requestId);
    const sourceId = trail.accessOutcome?.originatingRequestId;
    let sourceTrail = null;
    if (sourceId) {
      const source = await client.trail(sourceId);
      if (source.status === 200) sourceTrail = source.data;
    }
    const checks = checksFor(type, trail, review, sourceTrail);
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([field]) => field);
    reconstructed.push({
      name, type, requestId, queryMs, checks, missing,
      completeness: Number(((Object.keys(checks).length - missing.length) / Object.keys(checks).length).toFixed(6)),
      reconstructed: {
        requester: trail.request?.requester?.username || null,
        recordId: trail.request?.recordId || null,
        action: trail.request?.action || null,
        purpose: trail.request?.purpose || null,
        generationStatus: review?.recommendation?.generationStatus || null,
        recommendation: review?.recommendation?.recommendation || null,
        reasonCode: review?.recommendation?.reasonCode || null,
        policyRefs: review?.recommendation?.policyRefs || [],
        auditorDecision: trail.auditorDecision?.decision || null,
        llmAgreement: trail.auditorDecision?.llmAgreement || null,
        auditorReason: review?.auditorNote?.reason || null,
        processingBasis: trail.accessOutcome?.basis || null,
        authorizationId: trail.accessOutcome?.authorizationId || trail.auditorDecision?.createdAuthorizationId || null,
        originatingRequestId: sourceId || null,
        dynamicAuthorizationCheck: trail.request?.dynamicAuthorizationCheck || null,
      },
    });
  }
  const complete = reconstructed.filter((item) => item.completeness === 1).length;
  const report = {
    artifactType: 'dias-machine-audit-reconstruction',
    generatedAtUtc: new Date().toISOString(),
    sourceAcceptance: path.relative(REPO, acceptanceFile),
    method: 'Deterministic extraction from the deployed audit-trail API plus the backend off-chain review store.',
    summary: {
      cases: reconstructed.length,
      completelyReconstructed: complete,
      completenessRate: Number((complete / reconstructed.length).toFixed(6)),
    },
    cases: reconstructed,
    limitation: 'This establishes machine-readable field completeness only. It is not an independent human evaluation and does not establish explanation usefulness or human reconstruction time.',
  };
  fs.writeFileSync(path.join(outDir, 'audit-reconstruction.json'), `${JSON.stringify(report, null, 2)}\n`);
  const header = ['case', 'request_id', 'fields_checked', 'fields_present', 'completeness', 'query_ms', 'missing'];
  const rows = reconstructed.map((item) => {
    const total = Object.keys(item.checks).length;
    const presentCount = Object.values(item.checks).filter(Boolean).length;
    return [item.name, item.requestId || '', total, presentCount, item.completeness ?? 0, item.queryMs ?? '', (item.missing || []).join('|')];
  });
  const csv = `${[header, ...rows].map((row) => row.join(',')).join('\n')}\n`;
  fs.writeFileSync(path.join(outDir, 'audit-reconstruction.csv'), csv);
  fs.mkdirSync(path.join(REPO, 'results', 'tables'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'results', 'tables', 'dias_audit_reconstruction.csv'), csv);
  console.log(`${complete}/${reconstructed.length} cases mechanically complete`);
}

main().catch((error) => {
  console.error(`[audit-reconstruction] ${error.stack || error.message}`);
  process.exit(1);
});

