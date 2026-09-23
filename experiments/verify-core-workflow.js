'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const base = process.env.API_BASE || 'http://127.0.0.1:3001/api';
const output = path.join(
  root,
  'experiments/runs/20260903_core_llm_blockchain_workflow/live-verification.json'
);

async function request(method, endpoint, token) {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { status: response.status, contentType, body };
}

async function login(username) {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const body = await response.json();
  if (!body.success) throw new Error(`login failed for ${username}: ${body.error}`);
  return body.data.token;
}

async function main() {
  const [auditor, requester, owner] = await Promise.all([
    login('aud.qureshi'), login('insp.singh'), login('insp.sharma'),
  ]);
  const records = await request('GET', '/records?caseId=CASE-2026-001', auditor);
  const candidates = records.body.data
    .filter((item) => item.recordId.startsWith('FIR-API-'))
    .sort((a, b) => b.recordId.localeCompare(a.recordId));
  if (candidates.length === 0) throw new Error('no live FIR-API integration record was found');
  const recordId = process.env.CORE_WORKFLOW_RECORD_ID || candidates[0].recordId;

  const trail = await request('GET', `/audit/trail/${recordId}`, auditor);
  const approvalDecision = trail.body.data.accessDecisions.find((item) =>
    item.status === 'approved-after-escalation'
    && item.subject.role === 'inspector'
    && item.action === 'view');
  if (!approvalDecision) throw new Error(`no approved escalation exists for ${recordId}`);

  const metadata = await request(
    'GET', `/records/${recordId}/metadata/${approvalDecision.decisionId}`, requester
  );
  const requests = await request('GET', '/records/document-requests/mine', requester);
  const documentRequest = requests.body.data.find((item) =>
    item.recordId === recordId
    && item.decisionId === approvalDecision.decisionId
    && item.status === 'ready');
  if (!documentRequest) throw new Error(`no ready document request exists for ${recordId}`);

  const document = await request(
    'GET', `/records/document-requests/${documentRequest.requestId}/content`, requester
  );
  const wrongIdentity = await request(
    'GET', `/records/document-requests/${documentRequest.requestId}/content`, owner
  );
  const documentSha256 = crypto.createHash('sha256').update(document.body).digest('hex');

  const evidence = {
    capturedAtUtc: new Date().toISOString(),
    apiBase: base,
    recordId,
    decisionId: approvalDecision.decisionId,
    documentRequestId: documentRequest.requestId,
    checks: {
      escalationResolvedByAuditMsp: trail.body.data.approvals.some((item) =>
        item.decisionId === approvalDecision.decisionId
        && item.supervisorMsp === 'AuditMSP'
        && ['auditor', 'ombudsman'].includes(item.supervisorRole)),
      decisionStatus: approvalDecision.status,
      metadataHttpStatus: metadata.status,
      metadataExcludesOffChainReference: !Object.hasOwn(
        metadata.body.data || {}, 'offChainReference'
      ),
      metadataBoundToDecision: metadata.body.data?.authorizedByDecision
        === approvalDecision.decisionId,
      documentStatus: documentRequest.status,
      requesterDocumentHttpStatus: document.status,
      requesterDocumentContentType: document.contentType,
      requesterDocumentBytes: document.body.length,
      requesterDocumentSha256: documentSha256,
      ledgerDocumentSha256: documentRequest.contentHash,
      documentHashMatchesLedger: documentSha256 === documentRequest.contentHash,
      wrongIdentityHttpStatus: wrongIdentity.status,
      wrongIdentityRejected: wrongIdentity.status >= 400,
    },
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
