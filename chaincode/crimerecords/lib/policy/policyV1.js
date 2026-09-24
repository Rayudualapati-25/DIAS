'use strict';

/**
 * Policy v2 — declarative tables for the access-governance rules.
 *
 * The domain is rank-based: every role sits on a ladder inside its own
 * department, and authority (who heads a station, who heads a district, who may
 * review a refused request) is derived from that ladder in ./authority.js rather
 * than from any named individual.
 *
 * RBAC:  which roles may perform which actions on which record types.
 * ABAC:  contextual constraints (jurisdiction, assignment, clearance, flags).
 * PBAC:  policy versioning and review requirements.
 */

const {
  RANK_TABLE, CLEARANCE_RANK, DISTRICT_ONLY_DEPARTMENTS, DISTRICT_HEAD_ROLES,
} = require('./authority');

const POLICY_VERSION = 'crime-policy-v2';

// Roles are the rungs of the rank ladders; authority.js is the single source.
const ROLES = Object.freeze(Object.fromEntries(
  Object.keys(RANK_TABLE).map((role) => [role.toUpperCase().replace(/-/g, '_'), role])
));

const ACTIONS = Object.freeze(['view', 'export', 'annotate']);

const RECORD_TYPES = Object.freeze([
  'fir', 'case-diary', 'evidence', 'forensic-report', 'witness-statement',
  'chargesheet', 'court-order',
]);

const SENSITIVITY = Object.freeze(['low', 'medium', 'high']);

const POLICE_CASE_TYPES = Object.freeze([
  'fir', 'case-diary', 'witness-statement', 'evidence',
]);
const FORENSIC_TYPES = Object.freeze(['evidence', 'forensic-report']);
const COURT_FILING_TYPES = Object.freeze(['chargesheet', 'court-order']);

/**
 * RBAC base matrix: role -> record types it may request at all, per action.
 * A role/type pair absent here is a deny before any ABAC rule runs. Seniority on
 * the ladder widens what a role may reach, which is why the senior police,
 * forensic, prosecution and court ranks carry the full record-type list.
 */
const RBAC = Object.freeze({
  // Police
  constable: { view: ['fir'] },
  'sub-inspector': { view: ['fir', 'case-diary', 'witness-statement'] },
  inspector: {
    view: RECORD_TYPES,
    annotate: ['fir', 'case-diary'],
    export: ['fir', 'case-diary', 'chargesheet'],
  },
  'investigating-officer': {
    view: RECORD_TYPES,
    annotate: POLICE_CASE_TYPES,
    export: ['fir', 'case-diary', 'evidence', 'forensic-report'],
  },
  'circle-inspector': { view: RECORD_TYPES, annotate: POLICE_CASE_TYPES, export: RECORD_TYPES },
  dsp: { view: RECORD_TYPES, annotate: POLICE_CASE_TYPES, export: RECORD_TYPES },
  sp: { view: RECORD_TYPES, annotate: POLICE_CASE_TYPES, export: RECORD_TYPES },
  commissioner: { view: RECORD_TYPES, annotate: POLICE_CASE_TYPES, export: RECORD_TYPES },

  // Forensics
  'lab-assistant': { view: ['evidence'] },
  'lab-analyst': { view: FORENSIC_TYPES, annotate: ['forensic-report'] },
  'senior-analyst': { view: FORENSIC_TYPES, annotate: ['forensic-report'], export: ['forensic-report'] },
  'lab-director': { view: FORENSIC_TYPES, annotate: ['forensic-report'], export: FORENSIC_TYPES },
  'chief-forensic-officer': { view: FORENSIC_TYPES, annotate: FORENSIC_TYPES, export: FORENSIC_TYPES },

  // Prosecution. Defence sees only what is filed with the court.
  'defense-counsel': { view: COURT_FILING_TYPES },
  'assistant-public-prosecutor': { view: ['fir', ...COURT_FILING_TYPES] },
  'public-prosecutor': { view: RECORD_TYPES, export: COURT_FILING_TYPES },
  'senior-public-prosecutor': { view: RECORD_TYPES, export: COURT_FILING_TYPES },
  'director-of-prosecution': { view: RECORD_TYPES, export: RECORD_TYPES },

  // Court
  'court-clerk': { view: COURT_FILING_TYPES },
  magistrate: { view: RECORD_TYPES, annotate: ['court-order'], export: RECORD_TYPES },
  judge: { view: RECORD_TYPES, annotate: ['court-order'], export: RECORD_TYPES },
  'district-judge': { view: RECORD_TYPES, annotate: ['court-order'], export: RECORD_TYPES },
});

/**
 * Roles whose duty is cross-case review, so the case-assignment rule does not
 * apply to them. Jurisdiction still does: nobody reaches outside their district.
 */
const ASSIGNMENT_EXEMPT = Object.freeze([
  'circle-inspector', 'dsp', 'sp', 'commissioner',
  'lab-director', 'chief-forensic-officer',
  'public-prosecutor', 'senior-public-prosecutor', 'director-of-prosecution',
  'magistrate', 'judge', 'district-judge',
]);

/** Roles allowed to see juvenile-flagged records. Seniority alone never suffices. */
const JUVENILE_ALLOWED = Object.freeze([
  'investigating-officer',
  'public-prosecutor', 'senior-public-prosecutor', 'director-of-prosecution',
  'magistrate', 'judge', 'district-judge',
]);

/** Only the court may lift the seal it applied. */
const SEAL_AUTHORITY_ROLES = Object.freeze(['judge', 'district-judge']);

const PURPOSES = Object.freeze([
  'investigation', 'forensic-analysis', 'prosecution', 'judicial-proceeding',
  'audit-review', 'defense-preparation',
]);

module.exports = {
  POLICY_VERSION, ROLES, ACTIONS, RECORD_TYPES, SENSITIVITY, CLEARANCE_RANK,
  RBAC, ASSIGNMENT_EXEMPT, JUVENILE_ALLOWED, SEAL_AUTHORITY_ROLES, DISTRICT_HEAD_ROLES,
  DISTRICT_ONLY_DEPARTMENTS, PURPOSES,
};
