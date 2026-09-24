'use strict';

const express = require('express');
const { z } = require('zod');
const fabric = require('../fabric/gateway');
const vault = require('../storage/vault');
const { ok, fail, asyncRoute } = require('../util/respond');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Mirrors RecordContract.RECORD_CREATOR_ROLES. Filing is a station-level duty;
// listing extra senior roles here only turned a clean 403 into a late chaincode
// rejection after the vault write had already happened.
const { ROLES } = require('../../../chaincode/crimerecords/lib/policy/policyV1');
const RECORD_CREATOR_ROLES = [
  ROLES.CONSTABLE, ROLES.SUB_INSPECTOR, ROLES.INSPECTOR,
  ROLES.CIRCLE_INSPECTOR, ROLES.INVESTIGATING_OFFICER,
];

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PDF_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,122}\.pdf$/i;
const MAX_BASE64_PDF_LENGTH = Math.ceil(vault.MAX_PDF_BYTES / 3) * 4 + 4;

const createSchema = z.object({
  recordId: z.string().regex(SAFE_ID),
  payload: z.record(z.unknown()),
  meta: z.object({
    caseId: z.string().regex(SAFE_ID),
    recordType: z.enum(['fir', 'case-diary', 'evidence', 'forensic-report',
      'witness-statement', 'chargesheet', 'court-order']),
    sensitivityLevel: z.enum(['low', 'medium', 'high']),
    juvenileFlag: z.boolean().optional(),
    witnessFlag: z.boolean().optional(),
    owningStation: z.string().regex(SAFE_ID),
    jurisdiction: z.string().regex(SAFE_ID),
    victimProtectionFlag: z.boolean().optional(),
  }),
});

const searchSchema = z.object({
  caseId: z.string().regex(SAFE_ID).optional(),
  recordType: z.enum(['fir', 'case-diary', 'evidence', 'forensic-report',
    'witness-statement', 'chargesheet', 'court-order']).optional(),
  sensitivityLevel: z.enum(['low', 'medium', 'high']).optional(),
  owningStation: z.string().regex(SAFE_ID).optional(),
  jurisdiction: z.string().regex(SAFE_ID).optional(),
}).refine((v) => Object.values(v).some((x) => x !== undefined),
  { message: 'at least one search filter is required' });

/**
 * Case-file search. Returns on-chain metadata only — finding a record grants
 * no access to its contents; that still needs an access request.
 */
router.get('/', asyncRoute(async (req, res) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const filters = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined));

  const records = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'QueryRecords',
    JSON.stringify(filters));
  return ok(res, records);
}));

/** Store raw content in the agency vault, then commit its metadata/hash to Fabric. */
router.post('/', requireRole(...RECORD_CREATOR_ROLES),
  asyncRoute(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const { recordId, payload, meta } = parsed.data;

    const commitment = vault.save(req.user.org, recordId, payload);
    let record;
    try {
      record = await fabric.submit(
        req.user.org, req.user.fabricUser, 'RecordContract', 'CreateCaseRecord',
        recordId, JSON.stringify({
          ...meta,
          owningAgency: req.user.org,
          contentHash: commitment.contentHash,
          offChainReference: commitment.offChainReference,
          status: 'active',
        })
      );
    } catch (err) {
      if (commitment.created) vault.rollback(commitment.offChainReference);
      throw err;
    }
    return ok(res, record, 201);
  }));

const PUBLIC_INDEX_FIELDS = Object.freeze([
  'recordId', 'caseId', 'owningMsp', 'owningAgency', 'owningStation',
]);

/**
 * Find one case file by its identifier in the public record index — the same
 * identifier and ownership fields a case search returns to any role. Protected
 * metadata is never read, so an officer outside the owning station can find the
 * file before requesting access to it through DIAS.
 */
async function lookupRecord({ user, recordId, ledger = fabric }) {
  if (!SAFE_ID.test(recordId || '')) return { status: 400, error: 'recordId has invalid format' };
  const matches = await ledger.evaluate(
    user.org, user.fabricUser, 'RecordContract', 'QueryRecords', JSON.stringify({ recordId }));
  const record = matches.find((item) => item.recordId === recordId);
  if (!record) return { status: 404, error: 'case file not found' };
  return {
    status: 200,
    data: Object.fromEntries(PUBLIC_INDEX_FIELDS.map((name) => [name, record[name]])),
  };
}

router.get('/lookup/:recordId', asyncRoute(async (req, res) => {
  const found = await lookupRecord({ user: req.user, recordId: req.params.recordId });
  if (found.error) return fail(res, found.error, found.status);
  return ok(res, found.data);
}));

/** Requests visible to this exact requester or to staff at the owning station. */
router.get('/document-requests/mine', asyncRoute(async (req, res) => {
  const requests = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'QueryMyDocumentRequests');
  return ok(res, requests);
}));

const uploadDocumentSchema = z.object({
  fileName: z.string().regex(SAFE_PDF_NAME),
  mimeType: z.literal('application/pdf'),
  dataBase64: z.string().min(8).max(MAX_BASE64_PDF_LENGTH),
});

/** Owner-station staff upload the requested PDF to their off-chain vault. */
router.post('/document-requests/:requestId/upload',
  requireRole(...RECORD_CREATOR_ROLES),
  asyncRoute(async (req, res) => {
    const parsed = uploadDocumentSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const { dataBase64, fileName, mimeType } = parsed.data;
    if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
      return fail(res, 'dataBase64 must contain a valid base64 PDF');
    }
    const bytes = Buffer.from(dataBase64, 'base64');
    let commitment;
    try {
      commitment = vault.saveDocument(req.user.org, req.params.requestId, bytes);
    } catch (error) {
      return fail(res, error.message);
    }
    let request;
    try {
      request = await fabric.submit(
        req.user.org, req.user.fabricUser, 'RecordContract', 'UploadRequestedDocument',
        req.params.requestId, commitment.contentHash, commitment.offChainReference,
        fileName, mimeType);
    } catch (error) {
      if (commitment.created) vault.rollbackDocument(commitment.offChainReference);
      throw error;
    }
    return ok(res, { ...request, sizeBytes: commitment.sizeBytes });
  }));

/** Release PDF bytes only after Fabric re-checks the original requester identity. */
router.get('/document-requests/:requestId/content', asyncRoute(async (req, res) => {
  const authorization = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'AuthorizeRequestedDocumentRead',
    req.params.requestId);
  const stored = vault.readDocument(authorization.offChainReference);
  if (stored.currentHash !== authorization.contentHash) {
    return fail(res, 'PDF integrity check failed', 409);
  }
  return res.status(200).set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${authorization.fileName}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  }).send(stored.bytes);
}));

const documentRequestSchema = z.object({ decisionId: z.string().regex(SAFE_ID) });

/** An ALLOWed requester asks the record owner to supply the complete PDF. */
router.post('/:recordId/document-requests', asyncRoute(async (req, res) => {
  const parsed = documentRequestSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const request = await fabric.submit(
    req.user.org, req.user.fabricUser, 'RecordContract', 'CreateFullDocumentRequest',
    req.params.recordId, parsed.data.decisionId);
  return ok(res, request, 201);
}));

/** Metadata is gated by one exact ALLOW/approved decision. */
router.get('/:recordId/metadata/:decisionId', asyncRoute(async (req, res) => {
  const record = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'GetAuthorizedRecordMetadata',
    req.params.recordId, req.params.decisionId);
  return ok(res, record);
}));

/** On-chain metadata (any authenticated department member). */
router.get('/:recordId', asyncRoute(async (req, res) => {
  const record = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'GetRecord', req.params.recordId);
  return ok(res, record);
}));

/**
 * Off-chain raw content. Chaincode first verifies that the exact signing X.509
 * identity owns a grant, then the backend validates the file against Fabric's
 * content hash before release.
 */
router.get('/:recordId/payload', asyncRoute(async (req, res) => {
  return fail(res,
    'direct payload access is disabled; use the full-document request workflow', 410);
}));

const evidenceSchema = z.object({
  evidenceId: z.string().regex(SAFE_ID),
  artifact: z.string().min(1),
  source: z.string().min(1).max(200).default('agency-submission'),
  detail: z.string().max(2000).optional(),
});

/** Forensics attach an evidence commitment (detail goes to the PDC). */
router.post('/:recordId/evidence', requireRole('lab-analyst', 'lab-director'),
  asyncRoute(async (req, res) => {
    const parsed = evidenceSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, parsed.error.issues[0].message);
    const { evidenceId, artifact, detail, source } = parsed.data;
    const vaultId = `${req.params.recordId.slice(0, 60)}--${evidenceId.slice(0, 60)}`;
    const commitment = vault.save(req.user.org, vaultId, { artifact });
    const transient = detail ? { evidenceDetail: Buffer.from(detail, 'utf8') } : undefined;
    let result;
    try {
      result = await fabric.submitWithTransient(
        req.user.org, req.user.fabricUser, 'RecordContract', 'AttachEvidenceHash',
        [req.params.recordId, evidenceId, commitment.contentHash, source,
          commitment.offChainReference], transient);
    } catch (err) {
      if (commitment.created) vault.rollback(commitment.offChainReference);
      throw err;
    }
    return ok(res, result, 201);
  }));

router.get('/:recordId/evidence', asyncRoute(async (req, res) => {
  const list = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'ListEvidence', req.params.recordId);
  return ok(res, list);
}));

/** Private evidence detail — only Police, Forensics, and Court are members. */
router.get('/:recordId/evidence/:evidenceId/detail', asyncRoute(async (req, res) => {
  const detail = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'GetEvidenceDetail',
    req.params.recordId, req.params.evidenceId);
  return ok(res, detail);
}));

const custodySchema = z.object({
  toMsp: z.enum(['PoliceMSP', 'ForensicsMSP', 'CourtMSP']),
  reason: z.string().min(1).max(500),
});
router.post('/:recordId/evidence/:evidenceId/custody', asyncRoute(async (req, res) => {
  const parsed = custodySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, parsed.error.issues[0].message);
  const event = await fabric.submit(
    req.user.org, req.user.fabricUser, 'RecordContract', 'TransferEvidenceCustody',
    req.params.recordId, req.params.evidenceId, parsed.data.toMsp, parsed.data.reason);
  return ok(res, event);
}));

router.get('/:recordId/evidence/:evidenceId/custody', asyncRoute(async (req, res) => {
  const events = await fabric.evaluate(
    req.user.org, req.user.fabricUser, 'RecordContract', 'QueryEvidenceCustody',
    req.params.recordId, req.params.evidenceId);
  return ok(res, events);
}));

/** Court seals / unseals. */
router.post('/:recordId/seal', requireRole('judge', 'magistrate'), asyncRoute(async (req, res) => {
  const record = await fabric.submit(
    req.user.org, req.user.fabricUser, 'RecordContract', 'SealRecord', req.params.recordId);
  return ok(res, record);
}));

router.post('/:recordId/unseal', requireRole('judge', 'magistrate'), asyncRoute(async (req, res) => {
  const record = await fabric.submit(
    req.user.org, req.user.fabricUser, 'RecordContract', 'UnsealRecord', req.params.recordId);
  return ok(res, record);
}));

module.exports = router;
module.exports.lookupRecord = lookupRecord;
