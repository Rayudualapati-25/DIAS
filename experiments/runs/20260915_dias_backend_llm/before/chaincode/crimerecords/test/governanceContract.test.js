'use strict';

const { expect } = require('chai');
const chai = require('chai');
chai.use(require('chai-as-promised'));

const GovernanceContract = require('../lib/governanceContract');
const { buildMockContext, CALLERS } = require('./testHelpers');

const contract = new GovernanceContract();
const SHO = {
  mspId: 'PoliceMSP',
  attrs: { ...CALLERS.inspector.attrs, role: 'circle-inspector' },
};
const DEPARTMENT = {
  name: 'Police Department', type: 'police', jurisdiction: 'district-north',
  status: 'active', permittedFunctions: ['investigation', 'record-filing'],
};
const CASE = {
  owningAgency: 'police', jurisdiction: 'district-north', status: 'open',
  assignedUsers: ['insp.sharma'], protectedClassifications: ['witness'],
};


/** A district head of the authority organisation: the administrative authority. */
const DISTRICT_HEAD = {
  identityId: 'sp.north',
  mspId: 'AuditMSP',
  attrs: { role: 'sp', jurisdiction: 'district-north', clearance: 'high', credentialStatus: 'active' },
};

describe('GovernanceContract', () => {
  describe('who may create a department', () => {
    /**
     * Station and district heads sit in the authority organisation, so no
     * department contains a senior enough rank to register itself. Creating a
     * department is therefore an act of the authority, like admitting a user.
     */
    it('accepts a district head of the authority organisation', async () => {
      const ctx = buildMockContext({
        mspId: 'AuditMSP',
        attrs: { role: 'sp', jurisdiction: 'district-north', credentialStatus: 'active' },
      });
      const dept = JSON.parse(await contract.CreateDepartment(ctx, 'police', JSON.stringify({
        name: 'Police Department', type: 'police', jurisdiction: 'district-north',
        status: 'active', permittedFunctions: ['investigation'],
      })));
      expect(dept.departmentId).to.equal('police');
    });

    it('refuses a working officer of that department', async () => {
      const ctx = buildMockContext({
        mspId: 'PoliceMSP',
        attrs: { role: 'inspector', jurisdiction: 'district-north', credentialStatus: 'active' },
      });
      await expect(contract.CreateDepartment(ctx, 'police', JSON.stringify({
        name: 'Police Department', type: 'police', jurisdiction: 'district-north',
        status: 'active', permittedFunctions: ['investigation'],
      }))).to.be.rejectedWith(/requires membership/);
    });

    it('refuses a station head, who is not a district authority', async () => {
      const ctx = buildMockContext({
        mspId: 'AuditMSP',
        attrs: { role: 'circle-inspector', station: 'PS-Central', credentialStatus: 'active' },
      });
      await expect(contract.CreateDepartment(ctx, 'police', JSON.stringify({
        name: 'Police Department', type: 'police', jurisdiction: 'district-north',
        status: 'active', permittedFunctions: ['investigation'],
      }))).to.be.rejectedWith(/requires role/);
    });
  });

  it('creates and queries a department', async () => {
    // Registered by the district authority, but owned by the department itself.
    const ctx = buildMockContext(DISTRICT_HEAD);
    const item = JSON.parse(await contract.CreateDepartment(
      ctx, 'police', JSON.stringify(DEPARTMENT)));
    expect(item.owningMsp).to.equal('PoliceMSP');
    expect(JSON.parse(await contract.ReadDepartment(ctx, 'police')).name)
      .to.equal('Police Department');
    expect(JSON.parse(await contract.QueryDepartments(ctx))).to.have.length(1);
    await expect(contract.CreateDepartment(ctx, 'police', JSON.stringify(DEPARTMENT)))
      .to.be.rejectedWith(/already exists/);
  });

  it('blocks anyone outside the district authority', async () => {
    // Working officers, whatever their department, are not the authority.
    await expect(contract.CreateDepartment(
      buildMockContext(CALLERS.analyst), 'police', JSON.stringify(DEPARTMENT)
    )).to.be.rejectedWith(/requires membership/);
    await expect(contract.CreateDepartment(
      buildMockContext(CALLERS.inspector), 'police', JSON.stringify(DEPARTMENT)
    )).to.be.rejectedWith(/requires membership/);
  });

  it('creates, reads and lists a governed case', async () => {
    const ctx = buildMockContext(CALLERS.inspector);
    const item = JSON.parse(await contract.CreateCase(ctx, 'CASE-1', JSON.stringify(CASE)));
    expect(item.assignedUsers).to.deep.equal(['insp.sharma']);
    expect(JSON.parse(await contract.ReadCase(ctx, 'CASE-1')).status).to.equal('open');
    expect(JSON.parse(await contract.QueryCases(ctx))).to.have.length(1);
    await expect(contract.CreateCase(ctx, 'CASE-1', JSON.stringify(CASE)))
      .to.be.rejectedWith(/already exists/);
  });

  it('validates case ownership and protected classifications', async () => {
    const ctx = buildMockContext(CALLERS.inspector);
    await expect(contract.CreateCase(ctx, 'CASE-1', JSON.stringify({
      ...CASE, owningAgency: 'court',
    }))).to.be.rejectedWith(/requires membership/);
    await expect(contract.CreateCase(ctx, 'CASE-2', JSON.stringify({
      ...CASE, protectedClassifications: ['secret-vip'],
    }))).to.be.rejectedWith(/unsupported protected classification/);
  });

  it('lets a supervisor assign users without duplicates', async () => {
    const ctx = buildMockContext(SHO);
    await contract.CreateCase(ctx, 'CASE-1', JSON.stringify(CASE));
    let updated = JSON.parse(await contract.AssignCaseUser(ctx, 'CASE-1', 'io.krishnan'));
    expect(updated.assignedUsers).to.include('io.krishnan');
    updated = JSON.parse(await contract.AssignCaseUser(ctx, 'CASE-1', 'io.krishnan'));
    expect(updated.assignedUsers.filter((id) => id === 'io.krishnan')).to.have.length(1);
  });

  it('rejects unauthorized case creation and assignment', async () => {
    await expect(contract.CreateCase(
      buildMockContext(CALLERS.analyst), 'CASE-1', JSON.stringify(CASE)
    )).to.be.rejectedWith(/requires membership/);
    const ctx = buildMockContext(CALLERS.inspector);
    await contract.CreateCase(ctx, 'CASE-1', JSON.stringify(CASE));
    await expect(contract.AssignCaseUser(ctx, 'CASE-1', 'bad id!'))
      .to.be.rejectedWith(/invalid format/);
  });

  it('records prosecution/court workflow metadata with valid transitions', async () => {
    const state = buildMockContext(SHO);
    await contract.CreateCase(state, 'CASE-1', JSON.stringify(CASE));
    const prosecutor = buildMockContext({ ...CALLERS.prosecutor, txId: 'TX-FILE' });
    for (const [key, value] of state._state) prosecutor._state.set(key, value);
    const filed = JSON.parse(await contract.AdvanceCaseWorkflow(
      prosecutor, 'CASE-1', 'filed-to-court', 'FILING-1', 'charges filed'));
    expect(filed.nextStatus).to.equal('filed-to-court');
    const judge = buildMockContext({ ...CALLERS.judge, txId: 'TX-CLOSE' });
    for (const [key, value] of prosecutor._state) judge._state.set(key, value);
    await contract.AdvanceCaseWorkflow(judge, 'CASE-1', 'closed', 'ORDER-1', 'disposed');
    expect(JSON.parse(await contract.QueryCaseWorkflow(judge, 'CASE-1'))).to.have.length(2);
  });

  it('rejects invalid court workflow transitions', async () => {
    const state = buildMockContext(SHO);
    await contract.CreateCase(state, 'CASE-1', JSON.stringify(CASE));
    const judge = buildMockContext(CALLERS.judge);
    for (const [key, value] of state._state) judge._state.set(key, value);
    await expect(contract.AdvanceCaseWorkflow(
      judge, 'CASE-1', 'closed', 'ORDER-1', 'too early'))
      .to.be.rejectedWith(/filed to court/);
    await expect(contract.AdvanceCaseWorkflow(
      judge, 'CASE-1', 'reopened', 'ORDER-2', 'bad'))
      .to.be.rejectedWith(/nextStatus/);
  });
});
