/** Who may see which module. */

export const ORG = Object.freeze({
  POLICE: 'police',
  FORENSICS: 'forensics',
  PROSECUTION: 'prosecution',
  COURT: 'court',
  AUDIT: 'audit',
});

export const ORG_LABEL = Object.freeze({
  police: 'Police',
  forensics: 'Forensic Science Laboratory',
  prosecution: 'Prosecution',
  court: 'Judiciary',
  audit: 'Oversight & Internal Affairs',
});

/** District heads sit in the authority organisation. */
export const DISTRICT_HEAD_ROLES = Object.freeze([
  'sp', 'commissioner', 'chief-forensic-officer', 'director-of-prosecution', 'district-judge',
]);

/** Mirrors RecordContract.RECORD_CREATOR_ROLES (PoliceMSP): filing and PDF uploads. */
export const FILING_ROLES = Object.freeze([
  'constable', 'sub-inspector', 'inspector', 'circle-inspector', 'investigating-officer',
]);

/** Mirrors GovernanceContract.CreateCase (PoliceMSP). */
export const CASE_CREATOR_ROLES = Object.freeze([
  'sub-inspector', 'inspector', 'circle-inspector', 'investigating-officer',
]);

/** Mirrors RecordContract.EVIDENCE_ROLES (ForensicsMSP). */
export const FORENSIC_ROLES = Object.freeze(['lab-analyst', 'lab-director']);

/** Mirrors RecordContract.SEAL_ROLES (CourtMSP). */
export const JUDICIAL_ROLES = Object.freeze(['judge', 'magistrate']);

/** Mirrors AuditContract.REVIEWER_ROLES and REVIEWER_MSPS. */
export const REVIEWER_ROLES = Object.freeze([
  'judge', 'district-judge', 'sp', 'commissioner', 'chief-forensic-officer', 'director-of-prosecution',
]);
export const REVIEWER_ORGS = Object.freeze([ORG.AUDIT, ORG.COURT, ORG.PROSECUTION]);

/** Module `allow` rules that combine an organisation with its roles. */
export const ALLOW = Object.freeze({
  /** AccessContract auditor methods: AuditMSP district heads. */
  AUDITOR: Object.freeze({ roles: DISTRICT_HEAD_ROLES, orgs: [ORG.AUDIT] }),
  /** UserContract and GovernanceContract.CreateDepartment: AuditMSP district heads. */
  ADMINISTRATOR: Object.freeze({ roles: DISTRICT_HEAD_ROLES, orgs: [ORG.AUDIT] }),
  REVIEWER: Object.freeze({ roles: REVIEWER_ROLES, orgs: REVIEWER_ORGS }),
  FILING: Object.freeze({ roles: FILING_ROLES, orgs: [ORG.POLICE] }),
  SEAL: Object.freeze({ roles: JUDICIAL_ROLES, orgs: [ORG.COURT] }),
});

/** Every department a district head may admit an officer into. */
export const ADMINISTRATION_ORGS = Object.freeze([
  ORG.POLICE, ORG.FORENSICS, ORG.PROSECUTION, ORG.COURT, ORG.AUDIT,
]);

/** Every role a new account can be given. Mirrors ROLES in policyV1.js. */
export const ALL_ROLES = Object.freeze([
  'constable', 'sub-inspector', 'inspector', 'investigating-officer',
  'circle-inspector', 'dsp', 'sp', 'commissioner',
  'lab-assistant', 'lab-analyst', 'senior-analyst', 'lab-director', 'chief-forensic-officer',
  'defense-counsel', 'assistant-public-prosecutor', 'public-prosecutor',
  'senior-public-prosecutor', 'director-of-prosecution',
  'court-clerk', 'magistrate', 'judge', 'district-judge',
]);

/**
 * Which roles belong to which department, so the form cannot offer a combination the chaincode would
 * reject.
 */
export const ROLES_BY_ORG = Object.freeze({
  police: ['constable', 'sub-inspector', 'inspector', 'investigating-officer',
    'circle-inspector', 'dsp', 'sp', 'commissioner'],
  forensics: ['lab-assistant', 'lab-analyst', 'senior-analyst', 'lab-director',
    'chief-forensic-officer'],
  prosecution: ['defense-counsel', 'assistant-public-prosecutor', 'public-prosecutor',
    'senior-public-prosecutor', 'director-of-prosecution'],
  court: ['court-clerk', 'magistrate', 'judge', 'district-judge'],
  // The authority organisation holds the district head of every department.
  audit: [...DISTRICT_HEAD_ROLES],
});

/** Does this user satisfy a module's `allow` rule? */
export function canAccess(user, allow) {
  if (!user) return false;
  if (!allow) return true;
  if (allow.roles && !allow.roles.includes(user.role)) return false;
  if (allow.orgs && !allow.orgs.includes(user.org)) return false;
  if (allow.when && !allow.when(user)) return false;
  return true;
}

/** UserContract: admit, revoke or reinstate an officer of any department. */
export const canAdministerOfficers = (user) => canAccess(user, ALLOW.ADMINISTRATOR);

/** GovernanceContract.CreateCase. */
export const canCreateCase = (user) => user?.org === ORG.POLICE
  && CASE_CREATOR_ROLES.includes(user.role);

/** RecordContract.AttachEvidenceHash. */
export const canAttachEvidence = (user) => user?.org === ORG.FORENSICS
  && FORENSIC_ROLES.includes(user.role);

/** RecordContract.TransferEvidenceCustody: the custodian organisations. */
export const canTransferCustody = (user) => [ORG.POLICE, ORG.FORENSICS, ORG.COURT]
  .includes(user?.org);

/**
 * GovernanceContract.AdvanceCaseWorkflow: a police circle inspector or a public prosecutor files to court;
 * a judge or magistrate closes a filed case.
 */
export function canAdvanceCaseWorkflow(user) {
  if (!user) return false;
  if (user.org === ORG.POLICE) return user.role === 'circle-inspector';
  if (user.org === ORG.PROSECUTION) return user.role === 'public-prosecutor';
  if (user.org === ORG.COURT) return JUDICIAL_ROLES.includes(user.role);
  return false;
}
