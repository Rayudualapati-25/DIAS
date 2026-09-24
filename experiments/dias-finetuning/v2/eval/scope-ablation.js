#!/usr/bin/env node
'use strict';

/**
 * Scope ablation: exact-record authorization versus the SEAL property fingerprint.
 *
 * This is the one design decision the rewrite turned on, so it deserves a
 * measurement rather than an argument. Both designs are simulated over the same
 * request stream, with the same model answers and the same auditor behaviour;
 * only the scope key differs.
 *
 *   exact-record        stableUserId · recordId · caseId · action · purpose
 *   property fingerprint  the governed subject/request/record properties,
 *                         deliberately EXCLUDING recordId and caseId
 *
 * The quantity that matters is not how much work each design saves — a design
 * that auto-granted everything would save the most. It is how many DISTINCT
 * RECORDS each auditor approval ends up covering. Under exact-record that is
 * one, by construction. Under the property fingerprint it is however many
 * records happen to share those properties, and the auditor never saw them.
 *
 * No inference is involved: model answers come from the dataset labels, which is
 * what makes the two arms differ only in the scope key.
 *
 *   node experiments/dias-finetuning/v2/eval/scope-ablation.js --out <dir>
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { hashObject } = require('../../../../policies/lib/bundle');
const { createRng } = require('../lib/rng');

const DATASET = path.resolve(__dirname, '..', '..', 'data-v2-binary');
const DEFAULT_SEED = 20260912;

/** The deployed design. One record, one case, one action, one purpose. */
const exactScope = (request) => hashObject({
  scopeVersion: 'dias-authorization-scope-exact-record-v1',
  stableUserId: request.stableUserId,
  recordId: request.recordId,
  caseId: request.caseId,
  action: request.action,
  purpose: request.purpose,
});

/**
 * The SEAL design, reconstructed: governed properties only. recordId and caseId
 * are absent, which is precisely why one approval could reach another record.
 */
const propertyScope = (request) => hashObject({
  scopeVersion: 'seal-property-fingerprint',
  subject: request.verifiedRequest.requester,
  request: {
    action: request.action,
    purpose: request.purpose,
    emergencyFlag: request.verifiedRequest.request.emergencyFlag,
    approvalTokenPresent: request.verifiedRequest.request.approvalTokenPresent,
  },
  record: (({ caseId, ...rest }) => rest)(request.verifiedRequest.resource),
});

/**
 * Replay one request stream under one scope design.
 *
 * The auditor is modelled as the DIAS design specifies: they override a model
 * DENY to FORCE_ALLOW some of the time, and that is the only thing that creates
 * an authorization. `overrideDecision` is supplied by the caller so both arms
 * see identical auditor behaviour.
 */
function replay(stream, scopeOf, overrideDecision) {
  const authorizations = new Map(); // scope hash -> { approvedRecordId, requestId }
  const counters = {
    requests: stream.length,
    modelInvocations: 0,
    auditorReviews: 0,
    authorizationsCreated: 0,
    automaticGrants: 0,
    automaticGrantsOnTheApprovedRecord: 0,
    automaticGrantsOnADifferentRecord: 0,
  };
  const recordsCoveredByApproval = new Map(); // approving requestId -> Set(recordId)

  for (const request of stream) {
    const key = scopeOf(request);
    const held = authorizations.get(key);
    if (held) {
      counters.automaticGrants += 1;
      if (held.approvedRecordId === request.recordId) {
        counters.automaticGrantsOnTheApprovedRecord += 1;
      } else {
        counters.automaticGrantsOnADifferentRecord += 1;
      }
      recordsCoveredByApproval.get(held.requestId).add(request.recordId);
      continue;
    }
    counters.modelInvocations += 1;
    counters.auditorReviews += 1;
    // Only a model DENY the auditor overrides creates an authorization.
    if (request.label.recommendation === 'DENY' && overrideDecision(request)) {
      authorizations.set(key, { approvedRecordId: request.recordId, requestId: request.exampleId });
      recordsCoveredByApproval.set(request.exampleId, new Set([request.recordId]));
      counters.authorizationsCreated += 1;
    }
  }

  const coverage = [...recordsCoveredByApproval.values()].map((set) => set.size);
  return {
    ...counters,
    recordsPerApproval: {
      approvals: coverage.length,
      max: coverage.length ? Math.max(...coverage) : 0,
      mean: coverage.length
        ? Number((coverage.reduce((a, b) => a + b, 0) / coverage.length).toFixed(3)) : 0,
      approvalsReachingMoreThanOneRecord: coverage.filter((n) => n > 1).length,
    },
  };
}

/**
 * Build the replay stream.
 *
 * `siblings` is the parameter the whole ablation turns on. A sibling is a
 * DIFFERENT record, in a different case, with identical governed properties —
 * the same officer asking for another FIR of the same type, sensitivity and
 * jurisdiction from the same station. Under exact-record scope a sibling is a
 * different request. Under the property fingerprint it is the same one.
 *
 * With `siblings: 0` the stream holds no two records that share properties, and
 * the two designs are indistinguishable — which is itself worth reporting,
 * because it says the difference is conditional on siblings existing rather
 * than universal.
 */
function buildStream(rng, cases, repeats, siblings) {
  const base = cases.map((example) => ({
    exampleId: example.exampleId,
    stableUserId: `MSP::${example.username}`,
    recordId: example.recordId,
    caseId: example.caseId,
    action: example.verifiedRequest.request.action,
    purpose: example.verifiedRequest.request.purpose,
    verifiedRequest: example.verifiedRequest,
    label: example.label,
    isSibling: false,
  }));
  const identified = [...base];
  for (const request of base) {
    for (let s = 0; s < siblings; s += 1) {
      // A different record and case; every governed property identical, because
      // the verified request carries no record or case identifier of its own.
      identified.push({
        ...request,
        exampleId: `${request.exampleId}#s${s + 1}`,
        recordId: `${request.recordId}-SIB${s + 1}`,
        caseId: `${request.caseId}-SIB${s + 1}`,
        isSibling: true,
      });
    }
  }
  const stream = [...identified];
  for (let r = 0; r < repeats; r += 1) {
    for (const request of identified) {
      stream.push({ ...request, exampleId: `${request.exampleId}#r${r + 1}` });
    }
  }
  return rng.shuffle(stream);
}

function main() {
  const args = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const seed = Number(args.seed || DEFAULT_SEED);
  const repeats = Number(args.repeats || 3);
  const siblings = Number(args.siblings === undefined ? 2 : args.siblings);
  const outDir = path.resolve(args.out || 'experiments/runs/dias-scope-ablation');

  const cases = fs.readFileSync(path.join(DATASET, 'workflow-evaluation.cases.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const rng = createRng(seed, 'scope-ablation');
  const stream = buildStream(rng, cases, repeats, siblings);

  // One fixed auditor decision per request id, so both arms see the same
  // auditor. Without this the arms would differ by auditor behaviour too.
  const overrides = new Map();
  const overrideRng = createRng(seed, 'auditor');
  for (const request of stream) {
    const base = request.exampleId.split('#')[0];
    if (!overrides.has(base)) overrides.set(base, overrideRng.bool(0.5));
  }
  const overrideDecision = (request) => overrides.get(request.exampleId.split('#')[0]);

  const exact = replay(stream, exactScope, overrideDecision);
  const property = replay(stream, propertyScope, overrideDecision);

  const report = {
    artifactType: 'dias-scope-ablation',
    generatedAtUtc: new Date().toISOString(),
    seed,
    method: 'Both scope designs replay one identical request stream with identical '
      + 'model labels and identical auditor behaviour. Only the scope key differs, '
      + 'so every difference below is attributable to the scope design.',
    stream: {
      distinctCases: cases.length,
      siblingsPerCase: siblings,
      repeats,
      requests: stream.length,
      distinctRecords: new Set(stream.map((r) => r.recordId)).size,
      siblingNote: siblings === 0
        ? 'No two records share governed properties, so the designs coincide.'
        : `Each case has ${siblings} sibling record(s): a different record and case `
          + 'with identical governed properties, which is the situation the scope '
          + 'design decides.',
    },
    arms: { 'exact-record': exact, 'property-fingerprint': property },
    finding: {
      workSaved: 'Both designs skip the model and the auditor on a match; the property '
        + 'fingerprint matches at least as often, so it never does more work.',
      theCostThatMatters: 'How many DISTINCT RECORDS one auditor approval covers. '
        + 'Exact-record: one, by construction. Property fingerprint: every record '
        + 'sharing those governed properties, none of which the auditor saw.',
      exactRecordApprovalsReachingAnotherRecord:
        exact.automaticGrantsOnADifferentRecord,
      propertyApprovalsReachingAnotherRecord:
        property.automaticGrantsOnADifferentRecord,
    },
    deployedDesign: 'exact-record',
    limitation: 'A replay over synthetic workflow cases, not a live Fabric '
      + 'measurement. The difference between the designs is CONDITIONAL on records '
      + 'that share governed properties existing at all: with siblings 0 the two '
      + 'arms are identical. This bounds the scope difference; it does not measure '
      + 'how often siblings occur in real traffic, which is unknown.',
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'scope-ablation.json'), `${JSON.stringify(report, null, 2)}\n`);

  const rows = [['design', 'requests', 'model_invocations', 'auditor_reviews',
    'authorizations_created', 'automatic_grants', 'grants_on_approved_record',
    'grants_on_a_different_record', 'approvals', 'mean_records_per_approval',
    'max_records_per_approval', 'approvals_reaching_more_than_one_record']];
  for (const [design, arm] of Object.entries(report.arms)) {
    rows.push([design, arm.requests, arm.modelInvocations, arm.auditorReviews,
      arm.authorizationsCreated, arm.automaticGrants,
      arm.automaticGrantsOnTheApprovedRecord, arm.automaticGrantsOnADifferentRecord,
      arm.recordsPerApproval.approvals, arm.recordsPerApproval.mean,
      arm.recordsPerApproval.max, arm.recordsPerApproval.approvalsReachingMoreThanOneRecord]);
  }
  fs.mkdirSync(path.resolve('results/tables'), { recursive: true });
  fs.writeFileSync(path.resolve('results/tables/dias_scope_ablation.csv'),
    `${rows.map((r) => r.join(',')).join('\n')}\n`);

  for (const [design, arm] of Object.entries(report.arms)) {
    console.log(`${design.padEnd(22)} model ${String(arm.modelInvocations).padStart(4)}`
      + `  auditor ${String(arm.auditorReviews).padStart(4)}`
      + `  auto-grants ${String(arm.automaticGrants).padStart(4)}`
      + `  on a DIFFERENT record ${String(arm.automaticGrantsOnADifferentRecord).padStart(4)}`
      + `  records/approval mean ${arm.recordsPerApproval.mean} max ${arm.recordsPerApproval.max}`);
  }
  console.log(`\nwritten to ${outDir}/scope-ablation.json and results/tables/dias_scope_ablation.csv`);
}

if (require.main === module) main();
module.exports = { buildStream, exactScope, propertyScope, replay };
