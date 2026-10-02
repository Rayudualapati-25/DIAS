'use strict';

/**
 * Plan step 3: an auditor's certificate is not enough. A decision or a revocation
 * also needs an active ledger profile that matches the certificate, the district
 * that holds the record, and clearance for the record's sensitivity. Every
 * rejection must leave the ledger unchanged.
 */

const chai = require('chai');
chai.use(require('chai-as-promised'));
const { expect } = chai;

const { CALLERS } = require('./testHelpers');
const { DEFAULT_PROFILES, createDiasWorld, profileFor } = require('./diasTestWorld');

const INSPECTOR = CALLERS.inspector;
const AUDITOR = CALLERS.auditor;

const SOUTH_AUDITOR = Object.freeze({
  identityId: 'sp.south.test',
  mspId: 'AuditMSP',
  attrs: { role: 'sp', jurisdiction: 'district-south', clearance: 'high', credentialStatus: 'active' },
});
const LOW_CLEARANCE_AUDITOR = Object.freeze({
  identityId: 'dp.low.test',
  mspId: 'AuditMSP',
  attrs: {
    role: 'director-of-prosecution', jurisdiction: 'district-north', clearance: 'low', credentialStatus: 'active',
  },
});
const UNREGISTERED_AUDITOR = Object.freeze({
  identityId: 'cfo.ghost.test',
  mspId: 'AuditMSP',
  attrs: {
    role: 'chief-forensic-officer', jurisdiction: 'district-north', clearance: 'high', credentialStatus: 'active',
  },
});

describe('DIAS auditor authority (plan step 3)', () => {
  let world;

  beforeEach(async () => {
    world = await createDiasWorld().seed({
      profiles: [
        ...DEFAULT_PROFILES,
        profileFor(SOUTH_AUDITOR, 'audit'),
        profileFor(LOW_CLEARANCE_AUDITOR, 'audit'),
      ],
    });
  });

  async function pendingRequest() {
    const { result } = await world.submit(INSPECTOR);
    return result;
  }

  function setAuditorProfile(fields) {
    const profile = world.readState('user', AUDITOR.identityId);
    return world.putState('user', [AUDITOR.identityId], { ...profile, ...fields });
  }

  async function expectUndecided(requestId) {
    expect(world.readRequest(requestId).status).to.equal('awaiting-auditor');
    expect(world.readState('diasAuditorDecision', requestId)).to.equal(null);
  }

  describe('credential status', () => {
    for (const status of ['suspended', 'revoked']) {
      it(`rejects a decision by an auditor whose ledger profile is ${status}`, async () => {
        const request = await pendingRequest();
        await setAuditorProfile({ credentialStatus: status });
        await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY'))
          .to.be.rejectedWith(new RegExp(`DIAS_AUDITOR_INACTIVE: .*${status}`));
        await expectUndecided(request.requestId);
      });
    }

    it('rejects a decision signed with a certificate whose credential is not active', async () => {
      const request = await pendingRequest();
      const revokedCertificate = { ...AUDITOR, attrs: { ...AUDITOR.attrs, credentialStatus: 'revoked' } };
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY', { caller: revokedCertificate }))
        .to.be.rejectedWith(/DIAS_AUDITOR_INACTIVE: .*certificate/);
      await expectUndecided(request.requestId);
    });

    it('rejects a district head with no ledger profile', async () => {
      const request = await pendingRequest();
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY', { caller: UNREGISTERED_AUDITOR }))
        .to.be.rejectedWith(/DIAS_AUDITOR_INACTIVE: .*no ledger profile/);
      await expectUndecided(request.requestId);
    });

    it('rejects a certificate that does not match the auditor profile', async () => {
      const request = await pendingRequest();
      const otherDistrictCertificate = {
        ...AUDITOR, attrs: { ...AUDITOR.attrs, jurisdiction: 'district-south' },
      };
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY', { caller: otherDistrictCertificate }))
        .to.be.rejectedWith(/certificate jurisdiction does not match/);
      await expectUndecided(request.requestId);
    });
  });

  describe('district and clearance', () => {
    it('rejects a district head of another district', async () => {
      const request = await pendingRequest();
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY', { caller: SOUTH_AUDITOR }))
        .to.be.rejectedWith(/DIAS_AUDITOR_OUT_OF_DISTRICT/);
      await expectUndecided(request.requestId);
    });

    it('rejects a district head without clearance for the record', async () => {
      const request = await pendingRequest();
      await expect(world.decide(request.requestId, 'FORCE_DENY', 'DENY', { caller: LOW_CLEARANCE_AUDITOR }))
        .to.be.rejectedWith(/DIAS_AUDITOR_CLEARANCE/);
      await expectUndecided(request.requestId);
    });

    it('accepts an active district head of the record district with clearance', async () => {
      const request = await pendingRequest();
      const { result } = await world.decide(request.requestId, 'FORCE_DENY', 'DENY');
      expect(result.accessOutcome.outcome).to.equal('DENIED');
      expect(result.auditorDecision.auditor).to.include({ username: AUDITOR.identityId });
    });

    it('still refuses a decision on the auditor own request', async () => {
      const { result: own } = await world.submit(AUDITOR);
      await expect(world.decide(own.requestId, 'FORCE_ALLOW', 'DENY'))
        .to.be.rejectedWith(/cannot decide their own request/);
    });
  });

  describe('revocation', () => {
    it('requires the same active, in-district authority', async () => {
      const { authorization } = await world.createAuthorization();
      await expect(world.revoke(authorization.authorizationId, 'reason', { caller: SOUTH_AUDITOR }))
        .to.be.rejectedWith(/DIAS_AUDITOR_OUT_OF_DISTRICT/);
      await setAuditorProfile({ credentialStatus: 'suspended' });
      await expect(world.revoke(authorization.authorizationId, 'reason'))
        .to.be.rejectedWith(/DIAS_AUDITOR_INACTIVE/);
      expect(world.readState('diasAuthorization', authorization.authorizationId).status).to.equal('active');
      await setAuditorProfile({ credentialStatus: 'active' });
      const { result } = await world.revoke(authorization.authorizationId, 'Tasking ended.');
      expect(result.status).to.equal('revoked');
    });
  });
});
