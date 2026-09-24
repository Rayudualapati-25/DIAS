'use strict';

const RecordContract = require('./lib/recordContract');
const AccessContract = require('./lib/accessContract');
const AuditContract = require('./lib/auditContract');
const UserContract = require('./lib/userContract');
const GovernanceContract = require('./lib/governanceContract');
const PolicyContract = require('./lib/policyContract');

module.exports.RecordContract = RecordContract;
module.exports.AccessContract = AccessContract;
module.exports.AuditContract = AuditContract;
module.exports.UserContract = UserContract;
module.exports.GovernanceContract = GovernanceContract;
module.exports.PolicyContract = PolicyContract;
module.exports.contracts = [
  RecordContract, AccessContract, AuditContract, UserContract, GovernanceContract,
  PolicyContract,
];
