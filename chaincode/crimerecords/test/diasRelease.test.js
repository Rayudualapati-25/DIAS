'use strict';

/**
 * Plan step 4: the final PDF download re-checks the grant.
 *
 * Each test runs the real workflow — request, auditor decision (or reuse of a
 * dynamic authorization), full-document request, owner upload — and then changes
 * one condition before the requester downloads. The download must be refused
 * whenever the grant no longer holds at that moment.
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const OWNER_STATION_STAFF = CALLERS.constable;

describe('DIAS release at the final document download (plan step 4)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  const records = () => world.contracts.records;

  /** Request the full PDF for a granted decision and have the owner station upload it. */
  async function readyDocument(decisionId, { timestamp } = {}) {
    const { result: documentRequest } = await world.run(INSPECTOR, world.nextTx('DOCREQ'),
      (ctx) => records().CreateFullDocumentRequest(ctx, 'FIR-1', decisionId), { timestamp });
    await world.run(OWNER_STATION_STAFF, world.nextTx('UPLOAD'),
      (ctx) => records().UploadRequestedDocument(
        ctx, documentRequest.requestId, 'b'.repeat(64),
        `vault-pdf://police/${documentRequest.requestId}`, 'case-file.pdf', 'application/pdf'
      ), { timestamp });
    return documentRequest.requestId;
  }

  const download = (documentRequestId, { caller = INSPECTOR, timestamp } = {}) => world.run(
    caller, world.nextTx('DOWNLOAD'),
    (ctx) => records().AuthorizeRequestedDocumentRead(ctx, documentRequestId), { timestamp }
  );

  async function reviewedGrant() {
    const { result: request } = await world.submit(INSPECTOR);
    const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW');
    return result.accessOutcome.outcomeId;
  }

  async function reusedGrant(options = {}) {
    const { authorization } = await world.createAuthorization(INSPECTOR, options);
    const { result: repeat } = await world.submit(INSPECTOR, { timestamp: options.reuseAt });
    expect(repeat.processingPath).to.equal('dynamic-authorization');
    return { authorization, decisionId: repeat.outcomeId };
  }

  function setRequesterProfile(fields) {
    const profile = world.readState('user', INSPECTOR.identityId);
    return world.putState('user', [INSPECTOR.identityId], { ...profile, ...fields });
  }

  it('releases a reviewed grant to its requester', async () => {
    const documentId = await readyDocument(await reviewedGrant());
    const { result } = await download(documentId);
    expect(result).to.include({ recordId: 'FIR-1', contentHash: 'b'.repeat(64) });
  });

  for (const status of ['suspended', 'revoked']) {
    it(`refuses the download after the requester profile is ${status}`, async () => {
      const documentId = await readyDocument(await reviewedGrant());
      await setRequesterProfile({ credentialStatus: status });
      await expect(download(documentId)).to.be.rejectedWith(/credential is not active at release time/);
    });
  }

  it('refuses the download when the requester certificate is no longer active', async () => {
    const documentId = await readyDocument(await reviewedGrant());
    const revokedCertificate = { ...INSPECTOR, attrs: { ...INSPECTOR.attrs, credentialStatus: 'revoked' } };
    await expect(download(documentId, { caller: revokedCertificate }))
      .to.be.rejectedWith(/credential is not active at release time/);
  });

  it('refuses the download to any other identity', async () => {
    const documentId = await readyDocument(await reviewedGrant());
    await expect(download(documentId, { caller: CALLERS.constable }))
      .to.be.rejectedWith(/belongs to a different requester/);
  });

  it('refuses the download of a reused grant after its authorization is revoked', async () => {
    const { authorization, decisionId } = await reusedGrant();
    const documentId = await readyDocument(decisionId);
    expect((await download(documentId)).result.recordId).to.equal('FIR-1');
    await world.revoke(authorization.authorizationId, 'Tasking ended.');
    await expect(download(documentId)).to.be.rejectedWith(/no longer active/);
  });

  it('refuses the download of a reused grant after its authorization expires', async () => {
    const { decisionId } = await reusedGrant({ validUntilUtc: '2026-08-06T00:00:00Z' });
    const documentId = await readyDocument(decisionId);
    expect((await download(documentId, { timestamp: '2026-08-05T18:00:00Z' })).result.recordId)
      .to.equal('FIR-1');
    await expect(download(documentId, { timestamp: '2026-08-07T09:00:00Z' }))
      .to.be.rejectedWith(/no longer active/);
  });

  it('refuses the download of a reused grant whose authorization scope no longer matches', async () => {
    const { authorization, decisionId } = await reusedGrant();
    const documentId = await readyDocument(decisionId);
    const stored = world.readState('diasAuthorization', authorization.authorizationId);
    await world.putState('diasAuthorization', [authorization.authorizationId], {
      ...stored, scope: { ...stored.scope, purpose: 'audit-review' },
    });
    await expect(download(documentId)).to.be.rejectedWith(/scope does not match/);
  });

  it('refuses the download when the access decision behind it is not a granted view', async () => {
    const decisionId = await reviewedGrant();
    const documentId = await readyDocument(decisionId);
    const decision = world.readState('accessDecision', 'FIR-1', decisionId);
    await world.putState('accessDecision', ['FIR-1', decisionId], { ...decision, status: 'denied' });
    await expect(download(documentId)).to.be.rejectedWith(/status is 'denied'/);
  });
});
