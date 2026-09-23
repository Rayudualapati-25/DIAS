'use strict';

// LEGACY (SEAL / pre-DIAS): exercises retained modules that the DIAS runtime no longer
// loads and that deployCC.sh excludes from the chaincode package (see architectureGuard.test.js).

const { expect } = require('chai');
const { evaluate } = require('../../lib/policy/policyEngine');

const subject = (over = {}) => ({
  mspId: 'PoliceMSP', role: 'inspector', jurisdiction: 'district-north',
  clearance: 'high', credentialStatus: 'active', caseAssignments: 'CASE-1',
  station: 'PS-Central', ...over,
});
const record = (over = {}) => ({
  recordId: 'FIR-1', caseId: 'CASE-1', recordType: 'fir', sensitivityLevel: 'medium',
  jurisdiction: 'district-north', sealed: false, juvenileFlag: false,
  witnessFlag: false, victimProtectionFlag: false, ...over,
});
const env = (over = {}) => ({ purpose: 'investigation', ...over });
const run = (s, r, action = 'view', e = env()) => evaluate(s, r, action, e);

describe('policyEngine (crime-policy-v2)', () => {
  it('allows a fully compliant request with decisive attributes', () => {
    const out = run(subject(), record());
    expect(out.decision).to.equal('allow');
    expect(out.reasonCode).to.equal('POLICY_SATISFIED');
    expect(out.decisiveAttributes).to.be.an('array').that.is.not.empty;
    expect(out.policyVersion).to.equal('crime-policy-v2');
  });

  it('denies when the credential is not active (rule 1)', () => {
    expect(run(subject({ credentialStatus: 'revoked' }), record()).reasonCode)
      .to.equal('CRED_NOT_ACTIVE');
  });

  it('denies a missing or unknown purpose (rule 2)', () => {
    expect(run(subject(), record(), 'view', env({ purpose: 'curiosity' })).reasonCode)
      .to.equal('INVALID_PURPOSE');
    expect(run(subject(), record(), 'view', env({ purpose: undefined })).reasonCode)
      .to.equal('INVALID_PURPOSE');
  });

  it('denies when RBAC gives the role no such permission (rule 3)', () => {
    expect(run(subject({ role: 'constable' }), record({ recordType: 'chargesheet' })).reasonCode)
      .to.equal('RBAC_NO_PERMISSION');
    expect(run(subject({ role: 'not-a-role' }), record()).reasonCode)
      .to.equal('RBAC_NO_PERMISSION');
  });

  it('does not let an AuditMSP title inherit an operational PoliceMSP role', () => {
    const out = run(subject({ mspId: 'AuditMSP', role: 'sp', caseAssignments: null }), record());
    expect(out.decision).to.equal('deny');
    expect(out.reasonCode).to.equal('RBAC_NO_PERMISSION');
    expect(out.decisiveAttributes).to.include('subject.mspId');
  });

  it('escalates a sealed record to the court for everyone outside it (rule 4)', () => {
    const out = run(subject(), record({ sealed: true }));
    expect(out.decision).to.equal('escalate');
    expect(out.reasonCode).to.equal('SEALED_RECORD');
  });

  it('lets the court open its own sealed record without escalation (rule 4)', () => {
    const out = run(
      subject({ mspId: 'CourtMSP', role: 'judge', caseAssignments: null }),
      record({ sealed: true })
    );
    expect(out.decision).to.equal('allow');
  });

  it('denies juvenile records outside the narrow legal exception (rule 5)', () => {
    expect(run(subject({ role: 'constable' }), record({ juvenileFlag: true })).reasonCode)
      .to.equal('JUVENILE_PROTECTED');
    expect(run(subject({ role: 'investigating-officer' }), record({ juvenileFlag: true })).decision)
      .to.equal('allow');
  });

  it('denies victim-protected raw content to forensics (rule 5b)', () => {
    const out = run(
      subject({ mspId: 'ForensicsMSP', role: 'lab-analyst', clearance: 'high' }),
      record({ recordType: 'evidence', victimProtectionFlag: true }),
      'view', env({ purpose: 'forensic-analysis' })
    );
    expect(out.reasonCode).to.equal('VICTIM_DATA_NOT_NECESSARY');
  });

  // CHANGED in v2: crossing a district is a refusal, not an escalation, and it
  // applies to every role including the judiciary — a judge serves one district.
  it('denies any request that crosses a district, for every role (rule 6)', () => {
    for (const role of ['constable', 'inspector', 'sp', 'commissioner', 'judge', 'district-judge']) {
      const out = run(
        subject({ role, mspId: role.includes('judge') ? 'CourtMSP' : 'PoliceMSP', jurisdiction: 'district-south' }),
        record({ jurisdiction: 'district-north' })
      );
      expect(out.decision, role).to.equal('deny');
      expect(out.reasonCode, role).to.equal('CROSS_JURISDICTION');
    }
  });

  it('has no emergency override of any kind', () => {
    const out = run(
      subject({ jurisdiction: 'district-south' }), record({ jurisdiction: 'district-north' }),
      'view', env({ emergencyFlag: true, approvalToken: 'anything' })
    );
    expect(out.decision).to.equal('deny');
    expect(out.reasonCode).to.equal('CROSS_JURISDICTION');
  });

  it('denies unassigned officers with a counterfactual (rule 7)', () => {
    const out = run(subject({ caseAssignments: null }), record());
    expect(out.reasonCode).to.equal('NOT_ASSIGNED');
    expect(out.counterfactual).to.contain('CASE-1');
  });

  it('exempts cross-case roles from assignment but never from jurisdiction', () => {
    expect(run(subject({ role: 'sp', caseAssignments: null }), record()).decision).to.equal('allow');
    expect(run(
      subject({ role: 'sp', caseAssignments: null, jurisdiction: 'district-south' }), record()
    ).reasonCode).to.equal('CROSS_JURISDICTION');
  });

  // CHANGED in v2: a clearance shortfall is a refusal the requester may appeal.
  it('denies insufficient clearance rather than escalating (rule 8)', () => {
    const out = run(subject({ clearance: 'low' }), record({ sensitivityLevel: 'high' }));
    expect(out.decision).to.equal('deny');
    expect(out.reasonCode).to.equal('INSUFFICIENT_CLEARANCE');
  });

  it('treats a missing clearance attribute as no clearance (rule 8)', () => {
    expect(run(subject({ clearance: null }), record()).reasonCode)
      .to.equal('INSUFFICIENT_CLEARANCE');
  });

  // A witness-flagged file carries no extra barrier: whoever may open the case
  // file sees the witnesses recorded in it.
  it('never blocks on the witness flag alone', () => {
    expect(run(subject(), record({ witnessFlag: true })).decision).to.equal('allow');
  });

  it('is deterministic: same input, same output', () => {
    const a = run(subject(), record());
    const b = run(subject(), record());
    expect(a).to.deep.equal(b);
  });
});
