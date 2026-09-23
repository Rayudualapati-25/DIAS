'use strict';

/** Live six-organization DIAS acceptance through the public HTTP API. */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.DIAS_BASE_URL || 'http://127.0.0.1:3001/api';
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(
  REPOSITORY_ROOT, 'experiments', 'runs', '20260910_dias_live_fabric'
);
const steps = [];

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, route, { token, body } = {}) {
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const envelope = await response.json();
  if (!envelope.success) {
    throw new Error(`${method} ${route} -> ${response.status}: ${envelope.error}`);
  }
  return { status: response.status, data: envelope.data };
}

async function login(username) {
  const result = await request('POST', '/auth/login', { body: { username } });
  return result.data.token;
}

function recordStep(name, evidence) {
  steps.push({ name, status: 'passed', evidence });
}

async function submitAccess(token, recordId, purpose = 'investigation') {
  return request('POST', '/access/llm-request', {
    token,
    body: {
      recordId,
      action: 'view',
      purpose,
      query: `I need to view record ${recordId} for ${purpose}.`,
    },
  });
}

async function ensureRepeatRecord(ownerToken) {
  const records = await request('GET', '/records?caseId=CASE-2026-001', {
    token: ownerToken,
  });
  const existing = records.data.find(
    (record) => record.recordId === 'REC-DIAS-REPEAT-001'
  );
  if (existing) return { record: existing, reused: true };

  const created = await request('POST', '/records', {
    token: ownerToken,
    body: {
      recordId: 'REC-DIAS-REPEAT-001',
      payload: { synthetic: true, summary: 'DIAS exact-repeat acceptance record' },
      meta: {
        caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'medium',
        juvenileFlag: false, witnessFlag: false, victimProtectionFlag: false,
        owningStation: 'PS-Central', jurisdiction: 'district-north',
      },
    },
  });
  return { record: created.data, reused: false };
}

async function findReusableFirstRequest(auditorToken) {
  const pending = await request('GET', '/access/auditor/pending', {
    token: auditorToken,
  });
  return pending.data.find((review) => (
    review.request?.requesterUsername === 'const.verma'
      && review.request?.recordId === 'REC-FIR-001'
      && review.recommendation?.recommendation === 'deny'
  ));
}

function isAcceptanceRule(rule) {
  const fingerprint = rule?.fingerprint;
  return rule?.status === 'active'
    && fingerprint?.subject?.username === 'const.verma'
    && fingerprint?.request?.action === 'view'
    && fingerprint?.request?.purpose === 'investigation'
    && fingerprint?.record?.recordType === 'fir'
    && fingerprint?.record?.sensitivityLevel === 'medium';
}

async function main() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const [requesterToken, auditorToken, ownerToken] = await Promise.all([
    login('const.verma'), login('sp.north'), login('insp.sharma'),
  ]);
  recordStep('authenticate three Fabric identities', {
    requester: 'const.verma', auditor: 'sp.north', owner: 'insp.sharma',
  });

  const repeatRecord = await ensureRepeatRecord(ownerToken);
  recordStep('same-property record is available', {
    recordId: 'REC-DIAS-REPEAT-001',
    reusedFromEarlierAttempt: repeatRecord.reused,
  });

  const activeRulesAtStart = await request(
    'GET', '/access/dynamic-rules?status=active', { token: auditorToken }
  );
  const existingRule = activeRulesAtStart.data.find(isAcceptanceRule);
  const reusableFirst = existingRule
    ? null : await findReusableFirstRequest(auditorToken);
  const first = existingRule
    ? await request('GET', `/access/request/${existingRule.sourceRequestId}`, {
      token: requesterToken,
    })
    : reusableFirst
      ? { status: 202, data: reusableFirst.request }
      : await submitAccess(requesterToken, 'REC-FIR-001');
  if (!existingRule) {
    check(first.status === 202, 'first request must be pending, not final');
    check(first.data.status === 'pending-auditor', 'first request did not reach auditor');
  }
  const firstRequestId = first.data.requestId;
  recordStep('dynamic miss -> live Qwen recommendation', {
    requestId: firstRequestId,
    status: existingRule ? 'completed-in-earlier-attempt' : first.data.status,
    recommendationId: first.data.recommendationId
      || reusableFirst?.recommendation?.recommendationId
      || existingRule?.sourceRecommendationId,
    reusedFromEarlierAttempt: Boolean(reusableFirst || existingRule),
  });

  const review = await request('GET', `/access/auditor/${firstRequestId}`, {
    token: auditorToken,
  });
  check(review.data.queryHashVerified === true, 'auditor query hash did not verify');
  check(review.data.recommendation.recommendation === 'deny',
    `expected live Qwen DENY, received ${review.data.recommendation.recommendation}`);
  recordStep('auditor reads complete Qwen DENY review', {
    username: review.data.recommendation.subject.username,
    recordId: review.data.request.recordId,
    recommendation: review.data.recommendation.recommendation,
    reasonCode: review.data.recommendation.reasonCode,
    modelVersion: review.data.recommendation.modelVersion,
    queryHashVerified: review.data.queryHashVerified,
  });

  const allowed = existingRule
    ? await request(
      'GET', `/access/decision/REC-FIR-001/${first.data.decisionId}`,
      { token: auditorToken }
    )
    : await request('POST', `/access/auditor/${firstRequestId}/decision`, {
      token: auditorToken,
      body: { decision: 'force-allow', note: 'live DIAS denial-override acceptance' },
    });
  check(allowed.data.decision === 'allow', 'force-allow was not final ALLOW');
  check(allowed.data.dynamicPolicyRuleCreated === true, 'denial override did not create rule');
  const fingerprintHash = allowed.data.dynamicPolicy.fingerprintHash;
  recordStep('auditor FORCE ALLOW creates rule and final grant', {
    decisionId: allowed.data.decisionId,
    decisionAuthority: allowed.data.decisionAuthority,
    dynamicPolicyRuleCreated: allowed.data.dynamicPolicyRuleCreated,
    fingerprintHash,
    reusedFromEarlierAttempt: Boolean(existingRule),
  });

  const metadata = await request(
    'GET', `/records/REC-FIR-001/metadata/${allowed.data.decisionId}`,
    { token: requesterToken }
  );
  check(metadata.data.recordId === 'REC-FIR-001', 'granted metadata was not released');
  recordStep('force-allowed decision unlocks data sharing', {
    recordId: metadata.data.recordId,
    authorizedByDecision: metadata.data.authorizedByDecision,
  });

  const repeated = await submitAccess(requesterToken, 'REC-DIAS-REPEAT-001');
  check(repeated.status === 201, 'exact repeat was not finalized immediately');
  check(repeated.data.decisionAuthority === 'dynamic-policy',
    'exact repeat did not use dynamic policy');
  check(repeated.data.llmInvoked === false && repeated.data.auditorRequired === false,
    'exact repeat unexpectedly required Qwen or auditor');
  recordStep('exact repeat auto-grants without Qwen or auditor', {
    requestId: repeated.data.requestId,
    decisionId: repeated.data.decisionId,
    ruleId: repeated.data.dynamicPolicy.ruleId,
    llmInvoked: repeated.data.llmInvoked,
    auditorRequired: repeated.data.auditorRequired,
  });

  const nearMiss = await submitAccess(
    requesterToken, 'REC-DIAS-REPEAT-001', 'audit-review'
  );
  check(nearMiss.status === 202 && nearMiss.data.status === 'pending-auditor',
    'one-field purpose near miss did not return to Qwen and auditor');
  const nearMissReview = await request(
    'GET', `/access/auditor/${nearMiss.data.requestId}`, { token: auditorToken }
  );
  check(nearMissReview.data.request.requestFingerprintHash !== fingerprintHash,
    'one-field purpose near miss reused the original fingerprint');
  const deniedNearMiss = await request(
    'POST', `/access/auditor/${nearMiss.data.requestId}/decision`, {
      token: auditorToken,
      body: { decision: 'force-deny', note: 'near-miss acceptance denial' },
    }
  );
  check(deniedNearMiss.data.dynamicPolicyRuleCreated === false,
    'force-denied near miss created a rule');
  recordStep('one-field near miss returns to Qwen and is force-denied', {
    requestId: nearMiss.data.requestId,
    changedField: 'request.purpose',
    recommendation: nearMissReview.data.recommendation.recommendation,
    finalDecision: deniedNearMiss.data.decision,
    dynamicPolicyRuleCreated: deniedNearMiss.data.dynamicPolicyRuleCreated,
  });

  const rules = await request('GET', '/access/dynamic-rules?status=active', {
    token: auditorToken,
  });
  check(rules.data.some((rule) => rule.fingerprintHash === fingerprintHash),
    'active dynamic rule was not queryable');

  const trail = await request('GET', '/audit/trail/REC-FIR-001', {
    token: auditorToken,
  });
  check(trail.data.llmRecommendations.some((item) => item.requestId === firstRequestId),
    'audit trail omitted the recommendation');
  check(trail.data.auditorDecisions.some((item) => item.requestId === firstRequestId),
    'audit trail omitted the auditor decision');
  check(trail.data.dynamicAccessRules.some((item) => item.fingerprintHash === fingerprintHash),
    'audit trail omitted the dynamic rule');
  recordStep('auditor reconstructs every stage', {
    accessRequests: trail.data.accessRequests.length,
    llmRecommendations: trail.data.llmRecommendations.length,
    auditorDecisions: trail.data.auditorDecisions.length,
    accessDecisions: trail.data.accessDecisions.length,
    dynamicAccessRules: trail.data.dynamicAccessRules.length,
  });

  const revoked = await request(
    'POST', `/access/dynamic-rules/${fingerprintHash}/revoke`, {
      token: auditorToken,
      body: { reason: 'live acceptance revocation' },
    }
  );
  check(revoked.data.status === 'revoked', 'rule did not become revoked');
  const afterRevoke = await submitAccess(requesterToken, 'REC-DIAS-REPEAT-001');
  check(afterRevoke.status === 202 && afterRevoke.data.status === 'pending-auditor',
    'revoked rule still auto-granted');
  await request('POST', `/access/auditor/${afterRevoke.data.requestId}/decision`, {
    token: auditorToken,
    body: { decision: 'force-deny', note: 'close post-revocation acceptance request' },
  });
  recordStep('latest blockchain rule state controls future requests', {
    fingerprintHash,
    revokedStatus: revoked.data.status,
    postRevocationRequestId: afterRevoke.data.requestId,
    postRevocationStatus: afterRevoke.data.status,
  });

  const output = {
    runId: '20260910_dias_live_fabric',
    status: 'passed',
    generatedAtUtc: new Date().toISOString(),
    environment: {
      baseUrl: BASE_URL,
      network: 'local Hyperledger Fabric, six organizations',
      liveQwenInference: true,
    },
    steps,
  };
  fs.writeFileSync(
    path.join(RUN_DIR, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const output = {
    runId: '20260910_dias_live_fabric',
    status: 'failed',
    generatedAtUtc: new Date().toISOString(),
    error: error.message,
    completedSteps: steps,
  };
  fs.writeFileSync(
    path.join(RUN_DIR, 'verification.json'), `${JSON.stringify(output, null, 2)}\n`
  );
  process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(1);
});
