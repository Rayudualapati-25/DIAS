/** THE MODULE REGISTRY. */

import requestAccess from './request-access.js';
import decisionLog from './decision-log.js';
import fileRecord from './file-record.js';
import documentRequests from './document-requests.js';
import evidence from './evidence.js';
import auditorReview from './auditor-review.js';
import sealRecord from './seal-record.js';
import auditTrail from './audit-trail.js';
import payloadIntegrity from './payload-integrity.js';
import accessLog from './access-log.js';
import registerUser from './register-user.js';
import userDirectory from './user-directory.js';
import cases from './cases.js';
import departments from './departments.js';

export const MODULES = Object.freeze([
  requestAccess,
  decisionLog,
  cases,
  fileRecord,
  documentRequests,
  evidence,
  auditorReview,
  sealRecord,
  auditTrail,
  payloadIntegrity,
  accessLog,
  registerUser,
  departments,
  userDirectory,
]);

/** Sidebar section order. Groups not listed here appear last, alphabetically. */
export const GROUP_ORDER = Object.freeze(['Access', 'Records', 'Review', 'Audit', 'People']);

export function moduleById(id) {
  return MODULES.find((module) => module.id === id) || null;
}
