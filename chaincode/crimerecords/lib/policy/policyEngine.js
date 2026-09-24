'use strict';

/**
 * Deterministic policy engine: evaluates a structured access request and
 * returns { decision, reasonCode, decisiveAttributes, counterfactual }.
 *
 * decision  : 'allow' | 'deny' | 'escalate'
 *
 * v2: no emergency override, districts are a hard boundary for every role, and a
 * clearance shortfall is a refusal the requester appeals to their own authority
 * rather than an automatic escalation.
 * Rules run in a fixed order; the first terminal rule wins, and the rule
 * that fired names the decisive attributes — this is what makes the
 * explanation artifact reviewable rather than decorative.
 */

const {
  POLICY_VERSION, CLEARANCE_RANK, RBAC, ASSIGNMENT_EXEMPT, JUVENILE_ALLOWED,
  PURPOSES,
} = require('./policyV1');
const { RANK_TABLE } = require('./authority');

// A role name is meaningful only inside the operational organization that owns
// its rank ladder.  This prevents, for example, an AuditMSP identity whose
// administrative title happens to be "sp" from inheriting PoliceMSP powers.
const MSP_DEPARTMENT = Object.freeze({
  PoliceMSP: 'police',
  ForensicsMSP: 'forensics',
  ProsecutionMSP: 'prosecution',
  CourtMSP: 'court',
});

function result(decision, reasonCode, decisiveAttributes, counterfactual) {
  return Object.freeze({
    decision,
    reasonCode,
    decisiveAttributes: Object.freeze([...decisiveAttributes]),
    counterfactual: counterfactual || null,
    policyVersion: POLICY_VERSION,
  });
}

/**
 * @param {object} subject  caller attribute snapshot (from identity.getCaller)
 * @param {object} record   record metadata from the ledger
 * @param {string} action   'view' | 'export' | 'annotate'
 * @param {object} env      { purpose, emergencyFlag, courtLink, approvalToken }
 */
function evaluate(subject, record, action, env) {
  // Rule 1 — credential state (PBAC: revocation handling).
  if (subject.credentialStatus !== 'active') {
    return result('deny', 'CRED_NOT_ACTIVE', ['subject.credentialStatus'],
      'the credential-status barrier would be removed if the requester credential status were "active"; remaining policy conditions would still be evaluated');
  }

  // Rule 2 — purpose is mandatory and must be a declared purpose.
  if (!env.purpose || !PURPOSES.includes(env.purpose)) {
    return result('deny', 'INVALID_PURPOSE', ['env.purpose'],
      `the purpose barrier would be removed if purpose were one of [${PURPOSES.join(', ')}]; remaining policy conditions would still be evaluated`);
  }

  // Rule 3 — RBAC base matrix: both the authenticated organization and role
  // must identify the same operational department, then the role must permit
  // this action on this type. AuditMSP and AIOrgMSP are deliberately outside
  // the operational record-access ladders.
  const roleDefinition = RANK_TABLE[subject.role];
  const expectedDepartment = MSP_DEPARTMENT[subject.mspId];
  const rolePerms = expectedDepartment && roleDefinition
    && roleDefinition.department === expectedDepartment
    ? RBAC[subject.role]
    : undefined;
  const permittedTypes = rolePerms ? rolePerms[action] : undefined;
  if (!permittedTypes || !permittedTypes.includes(record.recordType)) {
    return result('deny', 'RBAC_NO_PERMISSION',
      ['subject.mspId', 'subject.role', 'action', 'object.recordType'],
      `the RBAC barrier would be removed if organization '${subject.mspId}' and role '${subject.role}' were permitted to '${action}' '${record.recordType}' records; remaining policy conditions would still be evaluated`);
  }

  // Rule 4 — sealed records escalate for everyone except the court itself.
  if (record.sealed && subject.mspId !== 'CourtMSP') {
    return result('escalate', 'SEALED_RECORD', ['object.sealed', 'subject.mspId'],
      'the seal barrier would be removed if the record were not sealed or the requester belonged to CourtMSP; remaining policy conditions would still be evaluated');
  }

  // Rule 5 — juvenile protection is a hard deny except for the narrowly
  // enumerated legal roles. Rank alone never overrides this rule.
  if (record.juvenileFlag && !JUVENILE_ALLOWED.includes(subject.role)) {
    return result('deny', 'JUVENILE_PROTECTED',
      ['object.juvenileFlag', 'subject.role'],
      'the juvenile-protection barrier would be removed if the record were not juvenile-protected or the requester held a role in the juvenile exception; remaining policy conditions would still be evaluated');
  }

  // Rule 5b — data minimization for forensic work. Evidence metadata remains
  // queryable, but a forensic identity does not receive a victim-protected raw
  // record merely because it has an evidence-analysis role.
  if (record.victimProtectionFlag
      && [ 'lab-analyst', 'lab-director' ].includes(subject.role)) {
    return result('deny', 'VICTIM_DATA_NOT_NECESSARY',
      ['object.victimProtectionFlag', 'subject.role'],
      'the data-minimization barrier would be removed if the requested resource did not contain victim-protected raw data; remaining policy conditions would still be evaluated');
  }

  // Rule 6 — jurisdiction. A district is a hard boundary for EVERY role: a judge
  // serves one district's court, and seniority does not reach across districts.
  // There is no emergency override; a refused requester appeals to the authority
  // in their own chain of command instead.
  if (subject.jurisdiction !== record.jurisdiction) {
    return result('deny', 'CROSS_JURISDICTION',
      ['subject.jurisdiction', 'object.jurisdiction'],
      `the jurisdiction barrier would be removed if requester jurisdiction matched '${record.jurisdiction}'; remaining policy conditions would still be evaluated`);
  }

  // Rule 7 — case assignment (ABAC): non-exempt roles must be assigned.
  if (!ASSIGNMENT_EXEMPT.includes(subject.role)) {
    // Split on comma or pipe: Fabric CA's --id.attrs uses commas as the
    // attribute separator, so certificates carry assignments pipe-separated.
    const assignments = subject.caseAssignments
      ? subject.caseAssignments.split(/[,|]/).map((s) => s.trim())
      : [];
    if (!assignments.includes(record.caseId)) {
      return result('deny', 'NOT_ASSIGNED',
        ['subject.caseAssignments', 'object.caseId'],
        `the assignment barrier would be removed if case '${record.caseId}' were in the requester's active assignments; remaining policy conditions would still be evaluated`);
    }
  }

  // Rule 8 — sensitivity vs clearance: insufficient clearance is denied.
  const needed = CLEARANCE_RANK[record.sensitivityLevel] ?? 2;
  const held = CLEARANCE_RANK[subject.clearance] ?? -1;
  if (held < needed) {
    return result('deny', 'INSUFFICIENT_CLEARANCE',
      ['subject.clearance', 'object.sensitivityLevel'],
      `access would satisfy the clearance condition if requester clearance were '${record.sensitivityLevel}' or higher`);
  }

  // Default — every gate passed.
  const decisiveAttributes = [
    'subject.credentialStatus', 'env.purpose', 'subject.mspId', 'subject.role',
    'action', 'object.recordType', 'object.sealed', 'object.juvenileFlag',
    'object.victimProtectionFlag', 'subject.jurisdiction', 'object.jurisdiction',
  ];
  if (!ASSIGNMENT_EXEMPT.includes(subject.role)) {
    decisiveAttributes.push('subject.caseAssignments', 'object.caseId');
  }
  decisiveAttributes.push('subject.clearance', 'object.sensitivityLevel');
  return result('allow', 'POLICY_SATISFIED', decisiveAttributes,
    'the automatic ALLOW would change if any applicable credential, purpose, RBAC, seal, protected-data, jurisdiction, assignment, or clearance condition ceased to be satisfied');
}

module.exports = { evaluate, POLICY_VERSION, MSP_DEPARTMENT };
