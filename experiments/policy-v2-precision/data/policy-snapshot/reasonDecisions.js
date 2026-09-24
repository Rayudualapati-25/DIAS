'use strict';

// One policy-v2 result vocabulary shared by runtime and Fabric validation.
module.exports = Object.freeze({
  CRED_NOT_ACTIVE: 'deny',
  INVALID_PURPOSE: 'deny',
  RBAC_NO_PERMISSION: 'deny',
  SEALED_RECORD: 'escalate',
  JUVENILE_PROTECTED: 'deny',
  VICTIM_DATA_NOT_NECESSARY: 'deny',
  CROSS_JURISDICTION: 'deny',
  NOT_ASSIGNED: 'deny',
  INSUFFICIENT_CLEARANCE: 'deny',
  MODEL_POLICY_DISAGREEMENT: 'escalate',
  POLICY_SATISFIED: 'allow',
});
