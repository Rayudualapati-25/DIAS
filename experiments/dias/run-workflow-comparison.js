'use strict';

/**
 * Deterministic DIAS workflow comparison.
 *
 * This is an offline authorization-path replay, not a latency benchmark and
 * not an LLM-accuracy evaluation. It counts which requests would invoke Qwen,
 * reach an auditor, or match a dynamic rule under controlled variants.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  buildRequestFingerprint, fingerprintHash,
} = require('../../chaincode/crimerecords/lib/policy/dynamicPolicy');
const { hashObject } = require('../../chaincode/crimerecords/lib/util/validate');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const RUN_ID = '20260910_dias_workflow_comparison';
const DEFAULT_RUN_DIR = path.join(REPOSITORY_ROOT, 'experiments', 'runs', RUN_ID);

const BASE = Object.freeze({
  governed: {
    enrollmentId: 'const.verma',
    mspId: 'PoliceMSP',
    organization: 'police',
    role: 'constable',
    rank: '1',
    station: 'PS-Central',
    jurisdiction: 'district-north',
    clearance: 'medium',
    credentialStatus: 'active',
    caseAssignments: '',
  },
  record: {
    recordId: 'REC-FIR-SEED',
    caseId: 'CASE-SEED',
    recordType: 'fir',
    sensitivityLevel: 'medium',
    jurisdiction: 'district-north',
    owningAgency: 'police',
    owningStation: 'PS-Central',
    sealed: false,
    juvenileFlag: false,
    witnessFlag: false,
    victimProtectionFlag: false,
  },
  requestContext: { action: 'view', purpose: 'investigation' },
});

const MUTATIONS = Object.freeze([
  ['subject.username', (x) => { x.governed.enrollmentId = 'const.other'; }],
  ['subject.mspId', (x) => { x.governed.mspId = 'ForensicsMSP'; }],
  ['subject.organization', (x) => { x.governed.organization = 'forensics'; }],
  ['subject.role', (x) => { x.governed.role = 'sub-inspector'; }],
  ['subject.rank', (x) => { x.governed.rank = '2'; }],
  ['subject.station', (x) => { x.governed.station = 'PS-East'; }],
  ['subject.jurisdiction', (x) => { x.governed.jurisdiction = 'district-south'; }],
  ['subject.clearance', (x) => { x.governed.clearance = 'high'; }],
  ['subject.credentialStatus', (x) => { x.governed.credentialStatus = 'suspended'; }],
  ['subject.assignedToRequestedCase', (x) => {
    x.governed.caseAssignments = x.record.caseId;
  }],
  ['request.action', (x) => { x.requestContext.action = 'export'; }],
  ['request.purpose', (x) => { x.requestContext.purpose = 'audit-review'; }],
  ['record.recordType', (x) => { x.record.recordType = 'case-diary'; }],
  ['record.sensitivityLevel', (x) => { x.record.sensitivityLevel = 'high'; }],
  ['record.jurisdiction', (x) => { x.record.jurisdiction = 'district-south'; }],
  ['record.owningAgency', (x) => { x.record.owningAgency = 'prosecution'; }],
  ['record.owningStation', (x) => { x.record.owningStation = 'PS-East'; }],
  ['record.sealed', (x) => { x.record.sealed = true; }],
  ['record.juvenileFlag', (x) => { x.record.juvenileFlag = true; }],
  ['record.witnessFlag', (x) => { x.record.witnessFlag = true; }],
  ['record.victimProtectionFlag', (x) => { x.record.victimProtectionFlag = true; }],
]);

const clone = (value) => JSON.parse(JSON.stringify(value));

function deletePath(object, dottedPath) {
  const parts = dottedPath.split('.');
  const leaf = parts.pop();
  let cursor = object;
  for (const part of parts) cursor = cursor[part];
  delete cursor[leaf];
  return object;
}

function hashWithOmission(fingerprint, omittedDimension) {
  if (!omittedDimension) return fingerprintHash(fingerprint);
  return hashObject(deletePath(clone(fingerprint), omittedDimension));
}

function makeDataset() {
  const seedInput = clone(BASE);
  const seedFingerprint = buildRequestFingerprint(seedInput);
  const requests = [{
    scenarioId: 'seed-deny-force-allow',
    kind: 'seed-override',
    shouldAutoGrant: false,
    modelRecommendation: 'deny',
    auditorDecision: 'force-allow',
    input: seedInput,
    fingerprint: seedFingerprint,
    fingerprintHash: fingerprintHash(seedFingerprint),
  }];

  for (let index = 1; index <= 5; index += 1) {
    const input = clone(BASE);
    input.record.recordId = `REC-FIR-REPEAT-${index}`;
    input.record.caseId = `CASE-REPEAT-${index}`;
    const fingerprint = buildRequestFingerprint(input);
    requests.push({
      scenarioId: `exact-repeat-${index}`,
      kind: 'exact-repeat',
      shouldAutoGrant: true,
      modelRecommendation: null,
      auditorDecision: null,
      input,
      fingerprint,
      fingerprintHash: fingerprintHash(fingerprint),
    });
  }

  for (const [dimension, mutate] of MUTATIONS) {
    const input = clone(BASE);
    input.record.recordId = `REC-NEAR-${dimension.replace(/[^A-Za-z0-9]+/g, '-').toUpperCase()}`;
    mutate(input);
    const fingerprint = buildRequestFingerprint(input);
    requests.push({
      scenarioId: `near-miss-${dimension}`,
      kind: 'one-field-near-miss',
      changedDimension: dimension,
      shouldAutoGrant: false,
      modelRecommendation: 'deny',
      auditorDecision: 'force-deny',
      input,
      fingerprint,
      fingerprintHash: fingerprintHash(fingerprint),
    });
  }
  return {
    schemaVersion: 'dias-workflow-dataset-v1',
    seed: 20260910,
    description: 'One denial override, five exact repeats, and one near miss per fingerprint field.',
    requests,
  };
}

function runVariant(dataset, {
  variant,
  ruleCreationEnabled,
  lookupEnabled,
  omittedDimension = null,
}) {
  const ruleHashes = new Set();
  const events = [];
  const metrics = {
    variant,
    omittedDimension,
    requestCount: dataset.requests.length,
    llmInvocations: 0,
    auditorReviews: 0,
    dynamicPolicyMatches: 0,
    ruleCreations: 0,
    correctAutomaticGrants: 0,
    falseAutomaticGrants: 0,
    nearMissCount: dataset.requests.filter((r) => r.kind === 'one-field-near-miss').length,
  };

  for (const request of dataset.requests) {
    const comparisonHash = hashWithOmission(request.fingerprint, omittedDimension);
    const matched = lookupEnabled && ruleHashes.has(comparisonHash);
    if (matched) {
      metrics.dynamicPolicyMatches += 1;
      if (request.shouldAutoGrant) metrics.correctAutomaticGrants += 1;
      else metrics.falseAutomaticGrants += 1;
      events.push({ variant, scenarioId: request.scenarioId, path: 'dynamic-policy', outcome: 'allow' });
      continue;
    }

    metrics.llmInvocations += 1;
    metrics.auditorReviews += 1;
    const qualifies = request.modelRecommendation === 'deny'
      && request.auditorDecision === 'force-allow';
    if (ruleCreationEnabled && qualifies) {
      ruleHashes.add(comparisonHash);
      metrics.ruleCreations += 1;
    }
    events.push({
      variant,
      scenarioId: request.scenarioId,
      path: 'llm-auditor',
      modelRecommendation: request.modelRecommendation,
      auditorDecision: request.auditorDecision,
      ruleCreated: ruleCreationEnabled && qualifies,
    });
  }
  metrics.safeNearMissRate = (metrics.nearMissCount - metrics.falseAutomaticGrants)
    / metrics.nearMissCount;
  return { metrics, events };
}

function csv(rows, columns) {
  return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => {
    const value = row[column] ?? '';
    return JSON.stringify(value);
  }).join(',')).join('\n')}\n`;
}

function barPlot(rows) {
  const width = 760;
  const height = 300;
  const max = Math.max(...rows.map((row) => row.llmInvocations));
  const barWidth = 110;
  const gap = 50;
  const startX = 70;
  const baselineY = 240;
  const bars = rows.map((row, index) => {
    const h = (row.llmInvocations / max) * 170;
    const x = startX + index * (barWidth + gap);
    const y = baselineY - h;
    return `<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" fill="#4b7ff5"/>`
      + `<text x="${x + barWidth / 2}" y="${y - 8}" text-anchor="middle">${row.llmInvocations}</text>`
      + `<text x="${x + barWidth / 2}" y="${baselineY + 24}" text-anchor="middle">${row.variant}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/>
<text x="24" y="28" font-family="sans-serif" font-size="18" font-weight="700">Offline DIAS workflow replay: Qwen invocations</text>
<line x1="50" y1="${baselineY}" x2="730" y2="${baselineY}" stroke="#333"/>
<g font-family="sans-serif" font-size="13" fill="#111">${bars}</g>
<text x="20" y="150" transform="rotate(-90 20 150)" text-anchor="middle" font-family="sans-serif" font-size="13">request count</text>
</svg>\n`;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main(runDir = process.argv[2] || DEFAULT_RUN_DIR) {
  fs.mkdirSync(runDir, { recursive: true });
  const dataset = makeDataset();
  const definitions = [
    { variant: 'baseline', ruleCreationEnabled: false, lookupEnabled: false },
    { variant: 'proposed', ruleCreationEnabled: true, lookupEnabled: true },
    { variant: 'ablation-rule-creation-off', ruleCreationEnabled: false, lookupEnabled: true },
    { variant: 'ablation-lookup-off', ruleCreationEnabled: true, lookupEnabled: false },
  ];
  const runs = definitions.map((definition) => runVariant(dataset, definition));
  const baselineInvocations = runs[0].metrics.llmInvocations;
  for (const run of runs) {
    run.metrics.llmInvocationReductionVsBaseline =
      (baselineInvocations - run.metrics.llmInvocations) / baselineInvocations;
  }
  const dimensionAblations = MUTATIONS.map(([dimension]) => {
    const run = runVariant(dataset, {
      variant: `omit-${dimension}`,
      ruleCreationEnabled: true,
      lookupEnabled: true,
      omittedDimension: dimension,
    });
    run.metrics.llmInvocationReductionVsBaseline =
      (baselineInvocations - run.metrics.llmInvocations) / baselineInvocations;
    return run;
  });

  const config = {
    runId: RUN_ID,
    seed: dataset.seed,
    execution: 'offline deterministic workflow replay',
    latencyMeasured: false,
    modelAccuracyMeasured: false,
    variants: definitions,
    fingerprintDimensionAblations: MUTATIONS.map(([dimension]) => dimension),
  };
  const metrics = {
    runId: RUN_ID,
    generatedAtUtc: new Date().toISOString(),
    comparison: runs.map((run) => run.metrics),
    fingerprintAblations: dimensionAblations.map((run) => run.metrics),
  };
  const eventLines = [...runs, ...dimensionAblations]
    .flatMap((run) => run.events).map((event) => JSON.stringify(event)).join('\n');

  const runFiles = {
    'config.json': `${JSON.stringify(config, null, 2)}\n`,
    'dataset.json': `${JSON.stringify(dataset, null, 2)}\n`,
    'metrics.json': `${JSON.stringify(metrics, null, 2)}\n`,
    'event-log.jsonl': `${eventLines}\n`,
  };
  for (const [name, content] of Object.entries(runFiles)) {
    fs.writeFileSync(path.join(runDir, name), content);
  }

  const tableDir = path.join(REPOSITORY_ROOT, 'results', 'tables');
  const plotDir = path.join(REPOSITORY_ROOT, 'results', 'plots');
  fs.mkdirSync(tableDir, { recursive: true });
  fs.mkdirSync(plotDir, { recursive: true });
  const comparisonPath = path.join(tableDir, 'dias_workflow_comparison.csv');
  const ablationPath = path.join(tableDir, 'dias_fingerprint_ablation.csv');
  const plotPath = path.join(plotDir, 'dias_workflow_llm_invocations.svg');
  fs.writeFileSync(comparisonPath, csv(metrics.comparison, [
    'variant', 'requestCount', 'llmInvocations', 'auditorReviews',
    'dynamicPolicyMatches', 'ruleCreations', 'correctAutomaticGrants',
    'falseAutomaticGrants', 'safeNearMissRate', 'llmInvocationReductionVsBaseline',
  ]));
  fs.writeFileSync(ablationPath, csv(metrics.fingerprintAblations, [
    'variant', 'omittedDimension', 'llmInvocations', 'dynamicPolicyMatches',
    'correctAutomaticGrants', 'falseAutomaticGrants', 'safeNearMissRate',
  ]));
  fs.writeFileSync(plotPath, barPlot(metrics.comparison));

  const artifacts = [
    ...Object.keys(runFiles).map((name) => path.join(runDir, name)),
    comparisonPath, ablationPath, plotPath,
  ];
  const manifest = {
    runId: RUN_ID,
    artifacts: artifacts.map((file) => ({
      path: path.relative(REPOSITORY_ROOT, file),
      sha256: digest(file),
      bytes: fs.statSync(file).size,
    })),
  };
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { BASE, MUTATIONS, makeDataset, runVariant, hashWithOmission };
