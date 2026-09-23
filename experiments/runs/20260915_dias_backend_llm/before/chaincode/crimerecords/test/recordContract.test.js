'use strict';

const { expect } = require('chai');
const chai = require('chai');
chai.use(require('chai-as-promised'));

const RecordContract = require('../lib/recordContract');
const { sha256 } = require('../lib/util/validate');
const { buildMockContext, cloneInto, seedCase, CALLERS, RECORD_META } = require('./testHelpers');

const contract = new RecordContract();

async function createRecord(ctx, recordId = 'FIR-1', meta = RECORD_META) {
  const caseKey = ctx.stub.createCompositeKey('case', [meta.caseId]);
  const existingCase = await ctx.stub.getState(caseKey);
  if (!existingCase || existingCase.length === 0) await seedCase(ctx, meta.caseId);
  return contract.CreateCaseRecord(ctx, recordId, JSON.stringify(meta));
}

describe('RecordContract', () => {
  describe('CreateCaseRecord', () => {
    it('creates a record for an authorized police role', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      const stored = JSON.parse(await createRecord(ctx));
      expect(stored.recordId).to.equal('FIR-1');
      expect(stored.sealed).to.equal(false);
      expect(stored.owningMsp).to.equal('PoliceMSP');
      expect(stored.createdAtUtc).to.equal('2026-08-05T12:00:00.000Z');
      expect(ctx._events[0].name).to.equal('RecordCreated');
    });

    it('rejects non-police MSPs', async () => {
      const ctx = buildMockContext(CALLERS.analyst);
      await expect(createRecord(ctx)).to.be.rejectedWith(/requires membership in \[PoliceMSP\]/);
    });

    it('allows a constable to file (CCTNS station data entry)', async () => {
      const ctx = buildMockContext(CALLERS.constable);
      const stored = JSON.parse(await createRecord(ctx));
      expect(stored.createdByRole).to.equal('constable');
    });

    it('still rejects police roles outside the filing set', async () => {
      const ctx = buildMockContext({
        mspId: 'PoliceMSP',
        attrs: { role: 'traffic-warden', credentialStatus: 'active' },
      });
      await expect(createRecord(ctx)).to.be.rejectedWith(/requires role in/);
    });

    it('rejects a caller with no role attribute', async () => {
      const ctx = buildMockContext({ mspId: 'PoliceMSP', attrs: {} });
      await expect(createRecord(ctx)).to.be.rejectedWith(/caller role is missing/);
    });

    it('rejects unknown fields (allow-list, not denylist)', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      const meta = { ...RECORD_META, victimName: 'REAL PII' };
      await expect(createRecord(ctx, 'FIR-1', meta))
        .to.be.rejectedWith(/unknown fields not permitted: victimName/);
    });

    it('rejects a malformed content hash and a bad enum', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await expect(createRecord(ctx, 'FIR-1', { ...RECORD_META, contentHash: 'zz' }))
        .to.be.rejectedWith(/invalid format/);
      await expect(createRecord(ctx, 'FIR-1', { ...RECORD_META, sensitivityLevel: 'ultra' }))
        .to.be.rejectedWith(/must be one of/);
    });

    it('rejects non-boolean flags (type checking, not presence checking)', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await expect(createRecord(ctx, 'FIR-1', { ...RECORD_META, juvenileFlag: 'yes' }))
        .to.be.rejectedWith(/must be a boolean/);
    });

    it('rejects duplicates', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await createRecord(ctx);
      await expect(createRecord(ctx)).to.be.rejectedWith(/already exists/);
    });
  });

  describe('AttachEvidenceHash', () => {
    async function withRecord() {
      const policeCtx = buildMockContext(CALLERS.inspector);
      await createRecord(policeCtx);
      // Re-use the same backing state through a forensics identity.
      const ctx = buildMockContext(CALLERS.analyst);
      cloneInto(policeCtx, ctx);
      return ctx;
    }

    it('attaches evidence for a forensics analyst', async () => {
      const ctx = await withRecord();
      const out = JSON.parse(await contract.AttachEvidenceHash(
        ctx, 'FIR-1', 'EV-1', 'b'.repeat(64)));
      expect(out.evidenceHash).to.equal('b'.repeat(64));
      expect(out.labMsp).to.equal('ForensicsMSP');
    });

    it('writes transient detail to the private collection only', async () => {
      const ctx = await withRecord();
      ctx._setTransient(new Map([['evidenceDetail', Buffer.from('DNA profile detail')]]));
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      const pdcKeys = [...ctx._privateState.keys()];
      expect(pdcKeys).to.have.length(1);
      expect(pdcKeys[0]).to.match(/^evidenceDetails:/);
      // Public state must not contain the detail text.
      const publicJson = [...ctx._state.values()].join(' ');
      expect(publicJson).to.not.contain('DNA profile detail');
    });

    it('rejects police callers and bad hashes', async () => {
      const ctx = await withRecord();
      const policeCtx = buildMockContext(CALLERS.inspector);
      cloneInto(ctx, policeCtx);
      await expect(contract.AttachEvidenceHash(policeCtx, 'FIR-1', 'EV-1', 'b'.repeat(64)))
        .to.be.rejectedWith(/requires membership in \[ForensicsMSP\]/);
      await expect(contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'nothex'))
        .to.be.rejectedWith(/sha256/);
    });

    it('rejects duplicate evidence ids and missing records', async () => {
      const ctx = await withRecord();
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      await expect(contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'c'.repeat(64)))
        .to.be.rejectedWith(/already attached/);
      await expect(contract.AttachEvidenceHash(ctx, 'FIR-404', 'EV-2', 'b'.repeat(64)))
        .to.be.rejectedWith(/does not exist/);
    });

    it('reads private detail back for a collection member', async () => {
      const ctx = await withRecord();
      ctx._setTransient(new Map([['evidenceDetail', Buffer.from('DNA matched S-77')]]));
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      const out = JSON.parse(await contract.GetEvidenceDetail(ctx, 'FIR-1', 'EV-1'));
      expect(out.detail).to.equal('DNA matched S-77');
      expect(out.readByMsp).to.equal('ForensicsMSP');
    });

    it('blocks non-collection orgs from reading private detail', async () => {
      const ctx = await withRecord();
      ctx._setTransient(new Map([['evidenceDetail', Buffer.from('DNA matched S-77')]]));
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      const auditorCtx = buildMockContext(CALLERS.auditor);
      cloneInto(ctx, auditorCtx);
      await expect(contract.GetEvidenceDetail(auditorCtx, 'FIR-1', 'EV-1'))
        .to.be.rejectedWith(/requires membership in/);
    });

    it('errors when no private detail was supplied', async () => {
      const ctx = await withRecord();
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-2', 'c'.repeat(64));
      await expect(contract.GetEvidenceDetail(ctx, 'FIR-1', 'EV-2'))
        .to.be.rejectedWith(/no private detail/);
    });

    it('lists attached evidence', async () => {
      const ctx = await withRecord();
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-2', 'c'.repeat(64));
      const list = JSON.parse(await contract.ListEvidence(ctx, 'FIR-1'));
      expect(list).to.have.length(2);
    });

    it('records custody transfers and enforces the current custodian', async () => {
      const ctx = await withRecord();
      await contract.AttachEvidenceHash(
        ctx, 'FIR-1', 'EV-1', 'b'.repeat(64), 'lab intake',
        'vault://forensics/EV-1');
      const event = JSON.parse(await contract.TransferEvidenceCustody(
        ctx, 'FIR-1', 'EV-1', 'CourtMSP', 'filed as exhibit'));
      expect(event.fromMsp).to.equal('ForensicsMSP');
      expect(event.toMsp).to.equal('CourtMSP');
      const timeline = JSON.parse(await contract.QueryEvidenceCustody(ctx, 'FIR-1', 'EV-1'));
      expect(timeline).to.have.length(1);
      await expect(contract.TransferEvidenceCustody(
        ctx, 'FIR-1', 'EV-1', 'PoliceMSP', 'take back'))
        .to.be.rejectedWith(/current custodian/);
    });

    it('rejects invalid custody destinations and unknown evidence', async () => {
      const ctx = await withRecord();
      await contract.AttachEvidenceHash(ctx, 'FIR-1', 'EV-1', 'b'.repeat(64));
      await expect(contract.TransferEvidenceCustody(
        ctx, 'FIR-1', 'EV-1', 'MediaMSP', 'publish'))
        .to.be.rejectedWith(/toMsp/);
      await expect(contract.TransferEvidenceCustody(
        ctx, 'FIR-1', 'EV-404', 'CourtMSP', 'file'))
        .to.be.rejectedWith(/does not exist/);
    });
  });

  describe('SealRecord / UnsealRecord', () => {
    async function recordInCourtCtx() {
      const policeCtx = buildMockContext(CALLERS.inspector);
      await createRecord(policeCtx);
      const ctx = buildMockContext(CALLERS.judge);
      cloneInto(policeCtx, ctx);
      return ctx;
    }

    it('lets a judge seal and unseal without mutating history', async () => {
      const ctx = await recordInCourtCtx();
      const sealed = JSON.parse(await contract.SealRecord(ctx, 'FIR-1'));
      expect(sealed.sealed).to.equal(true);
      const unsealed = JSON.parse(await contract.UnsealRecord(ctx, 'FIR-1'));
      expect(unsealed.sealed).to.equal(false);
      const history = JSON.parse(await contract.GetRecordHistory(ctx, 'FIR-1'));
      expect(history.map((h) => h.value.sealed)).to.deep.equal([false, true, false]);
    });

    it('rejects double-sealing and non-court callers', async () => {
      const ctx = await recordInCourtCtx();
      await contract.SealRecord(ctx, 'FIR-1');
      await expect(contract.SealRecord(ctx, 'FIR-1')).to.be.rejectedWith(/already sealed/);
      const policeCtx = buildMockContext(CALLERS.inspector);
      cloneInto(ctx, policeCtx);
      await expect(contract.SealRecord(policeCtx, 'FIR-1'))
        .to.be.rejectedWith(/requires membership in \[CourtMSP\]/);
    });
  });

  describe('QueryRecords (case-file search)', () => {
    async function seeded() {
      const ctx = buildMockContext(CALLERS.inspector);
      await createRecord(ctx, 'FIR-1', RECORD_META);
      await createRecord(ctx, 'FIR-2', { ...RECORD_META, recordType: 'case-diary' });
      await createRecord(ctx, 'FIR-3', {
        ...RECORD_META, caseId: 'CASE-9', owningStation: 'PS-East',
      });
      return ctx;
    }

    it('finds every record belonging to a case', async () => {
      const ctx = await seeded();
      const found = JSON.parse(await contract.QueryRecords(ctx,
        JSON.stringify({ caseId: 'CASE-1' })));
      expect(found.map((r) => r.recordId).sort()).to.deep.equal(['FIR-1', 'FIR-2']);
      expect(found[0]).to.not.have.property('sensitivityLevel');
      expect(found[0]).to.not.have.property('offChainReference');
    });

    it('combines filters', async () => {
      const ctx = await seeded();
      const found = JSON.parse(await contract.QueryRecords(ctx,
        JSON.stringify({ caseId: 'CASE-1', recordType: 'case-diary' })));
      expect(found).to.have.length(1);
      expect(found[0].recordId).to.equal('FIR-2');
    });

    it('returns an empty list when nothing matches', async () => {
      const ctx = await seeded();
      const found = JSON.parse(await contract.QueryRecords(ctx,
        JSON.stringify({ caseId: 'CASE-404' })));
      expect(found).to.deep.equal([]);
    });

    it('refuses an unfiltered search and unknown filter fields', async () => {
      const ctx = await seeded();
      await expect(contract.QueryRecords(ctx, '{}'))
        .to.be.rejectedWith(/at least one filter/);
      await expect(contract.QueryRecords(ctx, JSON.stringify({ $where: 'evil' })))
        .to.be.rejectedWith(/unknown fields/);
    });

    it('requires an identity with a role', async () => {
      const ctx = buildMockContext({ mspId: 'PoliceMSP', attrs: {} });
      await expect(contract.QueryRecords(ctx, JSON.stringify({ caseId: 'CASE-1' })))
        .to.be.rejectedWith(/no role attribute/);
    });
  });

  describe('GetRecord', () => {
    it('errors for a missing record (real-shim empty Buffer semantics)', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await expect(contract.GetRecord(ctx, 'FIR-404')).to.be.rejectedWith(/does not exist/);
      expect(await contract.RecordExists(ctx, 'FIR-404')).to.equal(false);
    });

    it('limits ungated metadata to the owning station or AuditMSP', async () => {
      const ownerCtx = buildMockContext(CALLERS.inspector);
      await createRecord(ownerCtx);
      expect(JSON.parse(await contract.GetRecord(ownerCtx, 'FIR-1')).recordId)
        .to.equal('FIR-1');

      const auditorCtx = buildMockContext(CALLERS.auditor);
      cloneInto(ownerCtx, auditorCtx);
      expect(JSON.parse(await contract.GetRecord(auditorCtx, 'FIR-1')).recordId)
        .to.equal('FIR-1');

      const outsiderCtx = buildMockContext(CALLERS.analyst);
      cloneInto(ownerCtx, outsiderCtx);
      await expect(contract.GetRecord(outsiderCtx, 'FIR-1'))
        .to.be.rejectedWith(/requires an ALLOW decision/);
    });
  });

  describe('ALLOW-gated metadata and full-document requests', () => {
    async function grantedWorld(caller = CALLERS.analyst, status = 'granted',
      action = 'view', txId = 'DOC-REQ-1') {
      const ownerCtx = buildMockContext(CALLERS.inspector);
      await createRecord(ownerCtx);
      const requesterCtx = buildMockContext({ ...caller, txId });
      cloneInto(ownerCtx, requesterCtx);
      await requesterCtx.stub.putState(
        requesterCtx.stub.createCompositeKey('user', [caller.identityId]),
        Buffer.from(JSON.stringify({ fabricUser: caller.identityId, credentialStatus: 'active' }))
      );
      const decision = {
        docType: 'accessDecision', decisionId: 'DECISION-1', recordId: 'FIR-1',
        action, status,
        subject: { identityHash: sha256(requesterCtx.clientIdentity.getID()) },
      };
      await requesterCtx.stub.putState(
        requesterCtx.stub.createCompositeKey('accessDecision', ['FIR-1', 'DECISION-1']),
        Buffer.from(JSON.stringify(decision))
      );
      return requesterCtx;
    }

    it('releases metadata only for the exact granted view decision', async () => {
      const ctx = await grantedWorld();
      const metadata = JSON.parse(
        await contract.GetAuthorizedRecordMetadata(ctx, 'FIR-1', 'DECISION-1'));
      expect(metadata.recordId).to.equal('FIR-1');
      expect(metadata.authorizedByDecision).to.equal('DECISION-1');
      expect(metadata.contentCommitment).to.equal('a'.repeat(64));
      expect(metadata).to.not.have.property('offChainReference');

      const deniedCtx = await grantedWorld(CALLERS.analyst, 'denied');
      await expect(contract.GetAuthorizedRecordMetadata(
        deniedCtx, 'FIR-1', 'DECISION-1')).to.be.rejectedWith(/status is 'denied'/);
      const exportCtx = await grantedWorld(CALLERS.analyst, 'granted', 'export');
      await expect(contract.GetAuthorizedRecordMetadata(
        exportCtx, 'FIR-1', 'DECISION-1')).to.be.rejectedWith(/does not grant the 'view'/);
      await expect(contract.GetAuthorizedRecordMetadata(
        ctx, 'FIR-1', 'bad id')).to.be.rejectedWith(/decisionId has invalid format/);

      const otherCtx = buildMockContext(CALLERS.prosecutor);
      cloneInto(ctx, otherCtx);
      await expect(contract.GetAuthorizedRecordMetadata(
        otherCtx, 'FIR-1', 'DECISION-1')).to.be.rejectedWith(/different identity or record/);
    });

    it('runs the complete request, owner upload, and requester read workflow', async () => {
      const requesterCtx = await grantedWorld();
      const requested = JSON.parse(
        await contract.CreateFullDocumentRequest(requesterCtx, 'FIR-1', 'DECISION-1'));
      expect(requested).to.include({
        requestId: 'DOC-REQ-1', status: 'requested', ownerMsp: 'PoliceMSP',
        owningStation: 'PS-Central',
      });
      expect(JSON.parse(await contract.QueryMyDocumentRequests(requesterCtx)))
        .to.have.length(1);
      await expect(contract.CreateFullDocumentRequest(
        requesterCtx, 'FIR-1', 'DECISION-1')).to.be.rejectedWith(/already exists/);
      await expect(contract.AuthorizeRequestedDocumentRead(requesterCtx, 'DOC-REQ-1'))
        .to.be.rejectedWith(/not ready/);

      const ownerCtx = buildMockContext({ ...CALLERS.inspector, txId: 'DOC-UPLOAD-1' });
      cloneInto(requesterCtx, ownerCtx);
      expect(JSON.parse(await contract.QueryMyDocumentRequests(ownerCtx)))
        .to.have.length(1);
      const uploaded = JSON.parse(await contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64),
        'vault-pdf://police/DOC-REQ-1', 'case-file.pdf', 'application/pdf'));
      expect(uploaded.status).to.equal('ready');
      expect(uploaded.uploadedByRole).to.equal('inspector');

      const finalRequesterCtx = buildMockContext(CALLERS.analyst);
      cloneInto(ownerCtx, finalRequesterCtx);
      const released = JSON.parse(
        await contract.AuthorizeRequestedDocumentRead(finalRequesterCtx, 'DOC-REQ-1'));
      expect(released.offChainReference).to.equal('vault-pdf://police/DOC-REQ-1');
      expect(released.fileName).to.equal('case-file.pdf');
    });

    it('rejects document upload by the wrong organization or station', async () => {
      const requesterCtx = await grantedWorld();
      await contract.CreateFullDocumentRequest(requesterCtx, 'FIR-1', 'DECISION-1');

      const wrongOrgCtx = buildMockContext(CALLERS.analyst);
      cloneInto(requesterCtx, wrongOrgCtx);
      await expect(contract.UploadRequestedDocument(
        wrongOrgCtx, 'DOC-REQ-1', 'b'.repeat(64),
        'vault-pdf://forensics/DOC-REQ-1', 'case.pdf', 'application/pdf'))
        .to.be.rejectedWith(/requires membership in \[PoliceMSP\]/);

      const wrongStationCtx = buildMockContext({
        ...CALLERS.inspector,
        attrs: { ...CALLERS.inspector.attrs, station: 'PS-East' },
      });
      cloneInto(requesterCtx, wrongStationCtx);
      expect(JSON.parse(await contract.QueryMyDocumentRequests(wrongStationCtx)))
        .to.deep.equal([]);
      await expect(contract.UploadRequestedDocument(
        wrongStationCtx, 'DOC-REQ-1', 'b'.repeat(64),
        'vault-pdf://police/DOC-REQ-1', 'case.pdf', 'application/pdf'))
        .to.be.rejectedWith(/owning station/);
    });

    it('validates PDF commitments and keeps releases identity-bound', async () => {
      const requesterCtx = await grantedWorld();
      await contract.CreateFullDocumentRequest(requesterCtx, 'FIR-1', 'DECISION-1');
      const ownerCtx = buildMockContext({ ...CALLERS.inspector, txId: 'DOC-UPLOAD-2' });
      cloneInto(requesterCtx, ownerCtx);

      await expect(contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'bad', 'vault-pdf://police/DOC-REQ-1',
        'case.pdf', 'application/pdf')).to.be.rejectedWith(/sha256/);
      await expect(contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64), 'vault://police/DOC-REQ-1',
        'case.pdf', 'application/pdf')).to.be.rejectedWith(/PDF vault/);
      await expect(contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64), 'vault-pdf://police/DOC-REQ-1',
        '../case.pdf', 'application/pdf')).to.be.rejectedWith(/safe .pdf/);
      await expect(contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64), 'vault-pdf://police/DOC-REQ-1',
        'case.pdf', 'text/plain')).to.be.rejectedWith(/application\/pdf/);

      await contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64),
        'vault-pdf://police/DOC-REQ-1', 'case.pdf', 'application/pdf');
      await expect(contract.UploadRequestedDocument(
        ownerCtx, 'DOC-REQ-1', 'b'.repeat(64),
        'vault-pdf://police/DOC-REQ-1', 'case.pdf', 'application/pdf'))
        .to.be.rejectedWith(/not awaiting upload/);

      const outsiderCtx = buildMockContext(CALLERS.prosecutor);
      cloneInto(ownerCtx, outsiderCtx);
      await expect(contract.AuthorizeRequestedDocumentRead(outsiderCtx, 'DOC-REQ-1'))
        .to.be.rejectedWith(/different requester/);
      await expect(contract.AuthorizeRequestedDocumentRead(outsiderCtx, 'bad id'))
        .to.be.rejectedWith(/invalid format/);
      await expect(contract.AuthorizeRequestedDocumentRead(outsiderCtx, 'MISSING'))
        .to.be.rejectedWith(/does not exist/);
    });
  });

  describe('AuthorizeRecordRead', () => {
    it('returns only the governed off-chain reference after an identity-bound grant', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await createRecord(ctx);
      await ctx.stub.putState(
        ctx.stub.createCompositeKey('user', ['insp.test']),
        Buffer.from(JSON.stringify({ fabricUser: 'insp.test', credentialStatus: 'active' }))
      );
      const decision = {
        docType: 'accessDecision', decisionId: 'D-1', recordId: 'FIR-1',
        status: 'granted', action: 'view',
        subject: {
          identityHash: sha256(ctx.clientIdentity.getID()),
        },
      };
      await ctx.stub.putState(
        ctx.stub.createCompositeKey('accessDecision', ['FIR-1', 'D-1']),
        Buffer.from(JSON.stringify(decision))
      );
      const result = JSON.parse(await contract.AuthorizeRecordRead(ctx, 'FIR-1'));
      expect(result.offChainReference).to.equal('vault://police/FIR-1');
      expect(result).to.not.have.property('payload');
    });

    it('rejects a caller without an identity-bound grant', async () => {
      const ctx = buildMockContext(CALLERS.inspector);
      await createRecord(ctx);
      await expect(contract.AuthorizeRecordRead(ctx, 'FIR-1'))
        .to.be.rejectedWith(/no granted access decision/);
    });
  });

  describe('release re-checks the grant basis', () => {
    async function releaseWorld({ credentialStatus = 'active', authorization = null, action = 'view' } = {}) {
      const ctx = buildMockContext(CALLERS.inspector);
      await createRecord(ctx);
      await ctx.stub.putState(
        ctx.stub.createCompositeKey('user', ['insp.test']),
        Buffer.from(JSON.stringify({ fabricUser: 'insp.test', credentialStatus }))
      );
      const decision = {
        docType: 'accessDecision', decisionId: 'D-1', recordId: 'FIR-1', status: 'granted', action,
        decisionAuthority: authorization ? 'dynamic-authorization' : 'auditor',
        authorizationId: authorization ? authorization.authorizationId : null,
        subject: { identityHash: sha256(ctx.clientIdentity.getID()) },
      };
      await ctx.stub.putState(
        ctx.stub.createCompositeKey('accessDecision', ['FIR-1', 'D-1']),
        Buffer.from(JSON.stringify(decision))
      );
      if (authorization) {
        await ctx.stub.putState(
          ctx.stub.createCompositeKey('diasAuthorization', [authorization.authorizationId]),
          Buffer.from(JSON.stringify(authorization))
        );
      }
      return ctx;
    }

    it('refuses release after the requester credential is suspended', async () => {
      const ctx = await releaseWorld({ credentialStatus: 'suspended' });
      await expect(contract.AuthorizeRecordRead(ctx, 'FIR-1'))
        .to.be.rejectedWith(/credential is not active at release time/);
      await expect(contract.GetAuthorizedRecordMetadata(ctx, 'FIR-1', 'D-1'))
        .to.be.rejectedWith(/credential is not active at release time/);
    });

    it('releases a dynamic-authorization grant only while that authorization is active and unexpired', async () => {
      const active = await releaseWorld({
        authorization: { authorizationId: 'AUTH-1', status: 'active', validUntilUtc: null },
      });
      expect(JSON.parse(await contract.AuthorizeRecordRead(active, 'FIR-1')).grantedByDecision).to.equal('D-1');
      const revoked = await releaseWorld({
        authorization: { authorizationId: 'AUTH-1', status: 'revoked', validUntilUtc: null },
      });
      await expect(contract.AuthorizeRecordRead(revoked, 'FIR-1')).to.be.rejectedWith(/no longer active/);
      const expired = await releaseWorld({
        authorization: { authorizationId: 'AUTH-1', status: 'active', validUntilUtc: '2026-08-01T00:00:00.000Z' },
      });
      await expect(contract.GetAuthorizedRecordMetadata(expired, 'FIR-1', 'D-1'))
        .to.be.rejectedWith(/no longer active/);
    });

    it('never releases raw content on a grant for a different action', async () => {
      const ctx = await releaseWorld({ action: 'export' });
      await expect(contract.AuthorizeRecordRead(ctx, 'FIR-1'))
        .to.be.rejectedWith(/no granted access decision/);
    });
  });
});
