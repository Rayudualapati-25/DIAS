'use strict';

/**
 * Plan step 8: governed policy versions and policy binding (design §5).
 *
 * A policy version is registered by one active district head and activated by
 * another. Requests bind the active policy when they are created; decisions,
 * reuse and release are refused once a different policy is active, and an
 * authorization issued under an older policy never qualifies again.
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { POLICY_V1, createDiasWorld } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const V2 = Object.freeze({ policyVersion: 'dias-governance-policy-v2', policyHash: 'e'.repeat(64) });

describe('DIAS policy governance and binding (plan step 8)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed();
  });

  const governance = () => world.contracts.governance;
  const call = (caller, fn) => world.run(caller, world.nextTx('GOV'), fn).then(({ result }) => result);

  describe('policy registry', () => {
    it('activates the seeded policy and reports it as active', async () => {
      const active = await call(INSPECTOR, (ctx) => governance().GetActivePolicy(ctx));
      expect(active).to.include({ policyVersion: POLICY_V1.policyVersion, policyHash: POLICY_V1.policyHash });
      const versions = await call(INSPECTOR, (ctx) => governance().QueryPolicyVersions(ctx));
      expect(versions.map((item) => [item.policyVersion, item.status]))
        .to.deep.equal([[POLICY_V1.policyVersion, 'active']]);
    });

    it('needs a different district head to activate than the one who registered', async () => {
      await world.registerPolicy(V2);
      await expect(world.activatePolicy(V2.policyVersion, { caller: CALLERS.auditor }))
        .to.be.rejectedWith(/must be activated by a different district head/);
      const { result } = await world.activatePolicy(V2.policyVersion);
      expect(result).to.include({ policyVersion: V2.policyVersion, policyHash: V2.policyHash });
      const versions = await call(INSPECTOR, (ctx) => governance().QueryPolicyVersions(ctx));
      expect(Object.fromEntries(versions.map((item) => [item.policyVersion, item.status]))).to.deep.equal({
        [POLICY_V1.policyVersion]: 'retired', [V2.policyVersion]: 'active',
      });
    });

    it('never re-activates a retired version and refuses duplicates and malformed input', async () => {
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      await expect(world.activatePolicy(POLICY_V1.policyVersion))
        .to.be.rejectedWith(/is retired; only a registered version can be activated/);
      await expect(world.registerPolicy(V2)).to.be.rejectedWith(/already registered/);
      await expect(world.registerPolicy({ policyVersion: 'bad version', policyHash: 'f'.repeat(64) }))
        .to.be.rejectedWith(/policyVersion has invalid format/);
      await expect(world.registerPolicy({ policyVersion: 'p3', policyHash: 'XYZ' }))
        .to.be.rejectedWith(/policyHash must be a SHA-256 digest/);
      await expect(world.activatePolicy('missing-version')).to.be.rejectedWith(/is not registered/);
    });

    it('accepts registration and activation only from active AuditMSP district heads', async () => {
      await expect(world.registerPolicy(V2, { caller: INSPECTOR }))
        .to.be.rejectedWith(/requires membership in \[AuditMSP\]/);
      const profile = world.readState('user', CALLERS.auditor2.identityId);
      await world.putState('user', [CALLERS.auditor2.identityId], { ...profile, credentialStatus: 'suspended' });
      await world.registerPolicy(V2);
      await expect(world.activatePolicy(V2.policyVersion)).to.be.rejectedWith(/DIAS_AUDITOR_INACTIVE/);
    });

    it('refuses every request while no policy is active', async () => {
      const bare = await createDiasWorld().seed({ policy: null });
      await expect(bare.submit(INSPECTOR)).to.be.rejectedWith(/DIAS_NO_ACTIVE_POLICY/);
    });
  });

  describe('binding', () => {
    it('binds a request, its decision, outcome and authorization to the active policy', async () => {
      const { request, decision, authorization } = await world.createAuthorization();
      for (const item of [request, decision.auditorDecision, decision.accessOutcome, authorization]) {
        expect(item).to.include({ policyVersion: POLICY_V1.policyVersion, policyHash: POLICY_V1.policyHash });
      }
      expect(world.readState('accessDecision', 'FIR-1', decision.accessOutcome.outcomeId))
        .to.include({ policyHash: POLICY_V1.policyHash });
    });

    it('rejects a decision once another policy is active, then lets the request be expired', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      await expect(world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW'))
        .to.be.rejectedWith(/DIAS_STALE_POLICY/);
      expect(world.readState('diasAuditorDecision', request.requestId)).to.equal(null);
      const { result } = await world.expire(request.requestId);
      expect(result.accessOutcome).to.include({ outcome: 'EXPIRED', basis: 'POLICY_VERSION_CHANGED' });
    });

    it('stops reusing an authorization after a policy change, without changing its status', async () => {
      const { authorization } = await world.createAuthorization();
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck.outcome).to.equal('POLICY_CHANGED');
      expect(repeat.status).to.equal('awaiting-auditor');
      expect(repeat.policyHash).to.equal(V2.policyHash);
      expect(world.readState('diasAuthorization', authorization.authorizationId).status).to.equal('active');
    });

    it('reissues the authorization under the new policy as a new generation', async () => {
      const first = await world.createAuthorization();
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      const second = await world.createAuthorization();
      expect(second.authorization).to.include({
        generation: 2, policyHash: V2.policyHash, supersedesAuthorizationId: first.authorization.authorizationId,
      });
      expect(world.readState('diasAuthorization', first.authorization.authorizationId).status).to.equal('superseded');
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck).to.include({
        outcome: 'MATCH', authorizationId: second.authorization.authorizationId,
      });
    });
  });

  describe('release after a policy change', () => {
    async function readyDocument(decisionId) {
      const { result: documentRequest } = await world.run(INSPECTOR, world.nextTx('DOCREQ'),
        (ctx) => world.contracts.records.CreateFullDocumentRequest(ctx, 'FIR-1', decisionId));
      await world.run(CALLERS.constable, world.nextTx('UPLOAD'), (ctx) => world.contracts.records
        .UploadRequestedDocument(ctx, documentRequest.requestId, 'b'.repeat(64),
          `vault-pdf://police/${documentRequest.requestId}`, 'case-file.pdf', 'application/pdf'));
      return documentRequest.requestId;
    }

    const download = (documentId) => world.run(INSPECTOR, world.nextTx('DOWNLOAD'),
      (ctx) => world.contracts.records.AuthorizeRequestedDocumentRead(ctx, documentId));

    it('refuses to release a reviewed grant issued under a retired policy', async () => {
      const { result: request } = await world.submit(INSPECTOR);
      const { result } = await world.decide(request.requestId, 'FORCE_ALLOW', 'ALLOW');
      const documentId = await readyDocument(result.accessOutcome.outcomeId);
      expect((await download(documentId)).result.recordId).to.equal('FIR-1');
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      await expect(download(documentId)).to.be.rejectedWith(/DIAS_STALE_POLICY/);
    });

    it('refuses to release a reused grant issued under a retired policy', async () => {
      await world.createAuthorization();
      const { result: repeat } = await world.submit(INSPECTOR);
      const documentId = await readyDocument(repeat.outcomeId);
      await world.changePolicy(V2.policyVersion, V2.policyHash);
      await expect(download(documentId)).to.be.rejectedWith(/DIAS_STALE_POLICY/);
    });
  });

  describe('records without a policy binding', () => {
    it('never reuses an authorization or releases a grant that carries no policy', async () => {
      const { authorization, decision } = await world.createAuthorization();
      const stored = world.readState('diasAuthorization', authorization.authorizationId);
      const { policyVersion, policyHash, ...legacy } = stored;
      await world.putState('diasAuthorization', [authorization.authorizationId], {
        ...legacy, schemaVersion: 'dias-dynamic-authorization-v2',
      });
      const { result: repeat } = await world.submit(INSPECTOR);
      expect(repeat.dynamicAuthorizationCheck.outcome).to.equal('NO_AUTHORIZATION');

      const outcomeId = decision.accessOutcome.outcomeId;
      const index = world.readState('accessDecision', 'FIR-1', outcomeId);
      const { policyVersion: v, policyHash: h, ...unbound } = index;
      await world.putState('accessDecision', ['FIR-1', outcomeId], unbound);
      await expect(world.run(INSPECTOR, world.nextTx('META'), (ctx) => world.contracts.records
        .GetAuthorizedRecordMetadata(ctx, 'FIR-1', outcomeId))).to.be.rejectedWith(/DIAS_LEGACY_RECORD/);
    });
  });
});

describe('policy digest of the repository policy', () => {
  it('matches the binding the test world activates, so tests use the real policy identity', () => {
    const bundle = require('../../../policies/dias-governance-policy-v1.json');
    const { policyHashOf, policyVersionOf } = require('../lib/dias/policyRegistry');
    expect(policyVersionOf(bundle)).to.equal(POLICY_V1.policyVersion);
    expect(policyHashOf(bundle)).to.equal(POLICY_V1.policyHash);
  });
});
