#!/usr/bin/env node
'use strict';

// Live engineering smoke check for the current v3 API. Uses synthetic demo
// data and actual Fabric/LLM calls. Tokens remain in memory. This is not the
// legacy acceptance suite, a model benchmark, or mobile synchronization.
const fs = require('fs');
const path = require('path');
const { createClient, sleep } = require('../scripts/dias/acceptance-client');

const output = path.resolve(process.argv[2]);
const existingRequestId = process.argv[3] || null;
const base = process.env.DIAS_API_URL || 'http://127.0.0.1:3001/api';
const client = createClient(base);
const report = {
  startedAt: new Date().toISOString(), base, existingRequestId,
  fixture: { recordId: 'REC-FIR-001', requester: 'insp.sharma', auditor: 'sp.north' },
  checks: [], evidence: {},
  limitations: ['One seeded-record path; no full acceptance-suite claim.',
    'No physical phone, emulator sync, public tunnel, or automatic mobile synchronization.',
    'No PDF upload/download, expiry, revocation, or multi-device conflict test in this check.'],
};

function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  console.log(`PASS ${name}`);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const resultFile = path.join(output, 'host-smoke.json');
  if (fs.existsSync(resultFile)) throw new Error('choose a new output directory; prior evidence exists');
  try {
    const health = await client.api('GET', '/health');
    check('backend health', health.status === 200 && health.data === 'ok', health);
    await client.token('insp.sharma');
    await client.token('sp.north');
    check('requester and auditor Fabric sign-in', true, 'Both real API logins succeeded.');

    let requestId = existingRequestId;
    if (!requestId) {
      const submitted = await client.submit('insp.sharma', {
        recordId: 'REC-FIR-001', action: 'view', purpose: 'investigation',
        justification: 'Host startup verification on the synthetic investigation record.',
      });
      check('request accepted for review', submitted.status === 202, submitted.status);
      requestId = submitted.data.requestId;
    }
    report.evidence.requestId = requestId;
    const request = await client.request('insp.sharma', requestId);
    check('committed requester and record binding', request.status === 200
      && request.data.requester.username === 'insp.sharma' && request.data.recordId === 'REC-FIR-001', request.status);
    check('justification is stored as a digest on the request',
      /^[a-f0-9]{64}$/.test(request.data.justificationHash)
      && !Object.hasOwn(request.data, 'justification'), { justificationHash: request.data.justificationHash });

    const deadline = Date.now() + 180000;
    let review;
    do {
      const response = await client.review(requestId);
      if (response.status !== 200) throw new Error(`review failed: ${response.status} ${response.error}`);
      review = response.data;
      if (review.recommendationState === 'committed') break;
      if (['failed', 'commit-rejected'].includes(review.recommendationState)) {
        throw new Error(`recommendation ended in ${review.recommendationState}`);
      }
      if (Date.now() >= deadline) throw new Error('no committed recommendation within 180 seconds');
      await sleep(1000);
    } while (true);
    check('real model generated a valid recommendation', review.recommendation.generationStatus === 'OK'
      && ['ALLOW', 'DENY'].includes(review.recommendation.recommendation), review.recommendation.recommendation);
    check('pre-review signed commitment is on Fabric', Boolean(review.commitment.commitmentId
      && review.commitment.txId && review.commitment.signature), review.commitment.commitmentId);
    check('off-chain recommendation matches its commitment', review.integrity.status === 'verified', review.integrity);
    report.evidence.recommendation = review.recommendation.recommendation;
    report.evidence.commitmentId = review.commitment.commitmentId;
    report.evidence.commitmentTxId = review.commitment.txId;

    const decision = review.recommendation.recommendation === 'ALLOW' ? 'FORCE_ALLOW' : 'FORCE_DENY';
    let decisionData;
    if (request.data.status === 'awaiting-auditor') {
      const decided = await client.decide(requestId, {
        decision, reason: 'Host startup verification on a synthetic demo record; agreeing with the committed recommendation.',
      });
      check('auditor decision committed', decided.status === 201, { status: decided.status, error: decided.error });
      decisionData = decided.data;
      report.evidence.decisionSource = 'POST auditor decision, then ledger readback';
    } else {
      const settled = await client.trail(requestId);
      check('existing auditor decision readable from the ledger', settled.status === 200
        && Boolean(settled.data.auditorDecision?.txId), settled.status);
      decisionData = settled.data;
      report.evidence.decisionSource = 'Existing committed decision read through GET audit trail; no duplicate decision submitted';
    }
    check('ledger derives agreement with the model', decisionData.auditorDecision.llmAgreement === 'AGREED',
      decisionData.auditorDecision.llmAgreement);
    const outcome = decisionData.accessOutcome;
    const expected = decision === 'FORCE_ALLOW' ? 'GRANTED' : 'DENIED';
    check('committed access outcome matches the decision', outcome.outcome === expected, outcome.outcome);
    report.evidence.auditorDecisionId = decisionData.auditorDecision.auditorDecisionId;
    report.evidence.outcomeId = outcome.outcomeId;
    report.evidence.outcome = outcome.outcome;

    const trail = await client.trail(requestId);
    check('audit trail readable', trail.status === 200, trail.status);
    const stages = trail.data.lifecycle.map(event => event.eventType);
    const required = ['ACCESS_REQUEST_SUBMITTED', 'DYNAMIC_AUTHORIZATION_CHECKED',
      'RECOMMENDATION_COMMITTED', 'AUDITOR_DECISION_RECORDED', 'AGREEMENT_DERIVED', 'ACCESS_OUTCOME_RECORDED'];
    check('audit lifecycle contains the current v3 stages in order',
      required.every((stage, index) => stages.indexOf(stage) >= 0
        && (index === 0 || stages.indexOf(stage) > stages.indexOf(required[index - 1]))), stages);
    report.evidence.lifecycle = stages;
    fs.writeFileSync(path.join(output, 'request-trail.json'), JSON.stringify(trail.data, null, 2) + '\n');

    if (outcome.outcome === 'GRANTED') {
      const metadata = await client.api('GET', `/records/REC-FIR-001/metadata/${outcome.outcomeId}`,
        { username: 'insp.sharma' });
      check('requester can read freshly authorized metadata', metadata.status === 200, metadata.status);
    }
    const payload = await client.api('POST', '/audit/verify-payload/REC-FIR-001', { username: 'sp.north' });
    check('agency vault payload matches the ledger commitment', payload.status === 200
      && payload.data.match === true && payload.data.storedHash === payload.data.computedHash,
      payload.data || payload.error);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    report.completedAt = new Date().toISOString();
    report.summary = { passed: report.checks.filter(item => item.ok).length,
      failed: report.checks.filter(item => !item.ok).length, total: report.checks.length };
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2) + '\n');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
