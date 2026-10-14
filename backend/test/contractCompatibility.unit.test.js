'use strict';

/** Backend/chaincode method compatibility. */

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CHAINCODE_LIB = path.join(REPO_ROOT, 'chaincode', 'crimerecords', 'lib');
/** Everything that invokes chaincode. */
const CALLER_ROOTS = Object.freeze([
  path.join(REPO_ROOT, 'backend', 'src'),
  path.join(REPO_ROOT, 'scripts'),
]);

const CONTRACT_FILES = Object.freeze({
  AccessContract: 'accessContract.js',
  AuditContract: 'auditContract.js',
  RecordContract: 'recordContract.js',
  UserContract: 'userContract.js',
  GovernanceContract: 'governanceContract.js',
});

/**
 * Every gateway call in the backend names the contract and the method as adjacent arguments: `...(org,
 * user, <contract>, 'SomeMethod'`.
 */
const CALL_PATTERN = /(?:'(\w+Contract)'|\b([A-Z_][A-Z0-9_]*)\b),\s*\n?\s*'(\w+)'/g;
const ALIAS_PATTERN = /const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'(\w+Contract)'/g;

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

function backendCalls() {
  const calls = new Map();
  for (const file of CALLER_ROOTS.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, 'utf8');
    const aliases = new Map(
      [...source.matchAll(ALIAS_PATTERN)].map(([, name, contract]) => [name, contract])
    );
    for (const [, literal, alias, method] of source.matchAll(CALL_PATTERN)) {
      const contract = literal || aliases.get(alias);
      if (!contract) continue;
      const key = `${contract}.${method}`;
      if (!calls.has(key)) calls.set(key, { contract, method, files: [] });
      if (!calls.get(key).files.includes(path.relative(REPO_ROOT, file))) {
        calls.get(key).files.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return [...calls.values()];
}

/** Public transaction names of a contract: its own prototype methods, minus internals. */
function contractMethods(contractName) {
  const ContractClass = require(path.join(CHAINCODE_LIB, CONTRACT_FILES[contractName]));
  return new Set(
    Object.getOwnPropertyNames(ContractClass.prototype)
      .filter((name) => name !== 'constructor' && !name.startsWith('_'))
      .filter((name) => typeof ContractClass.prototype[name] === 'function')
  );
}

describe('backend/chaincode contract compatibility', () => {
  const calls = backendCalls();

  it('finds the gateway calls it is supposed to check', () => {
    expect(calls.length).to.be.greaterThan(15);
  });

  it('names only contracts that exist in the chaincode', () => {
    const unknown = calls
      .filter((call) => !CONTRACT_FILES[call.contract])
      .map((call) => `${call.contract} (${call.files.join(', ')})`);
    expect(unknown, `unknown contracts: ${unknown.join('; ')}`).to.deep.equal([]);
  });

  it('calls only methods the deployed contracts expose', () => {
    const exposed = new Map(
      Object.keys(CONTRACT_FILES).map((name) => [name, contractMethods(name)])
    );
    const missing = calls
      .filter((call) => !exposed.get(call.contract)?.has(call.method))
      .map((call) => `${call.contract}.${call.method} called from ${call.files.join(', ')}`);
    expect(missing, `methods the chaincode does not expose:\n  ${missing.join('\n  ')}`)
      .to.deep.equal([]);
  });

  it('still calls the DIAS workflow methods the redesign introduced', () => {
    const invoked = new Set(calls.map((call) => `${call.contract}.${call.method}`));
    const required = [
      'AccessContract.CreateAccessRequest',
      'AccessContract.SubmitAuditorDecision',
      'AccessContract.QueryPendingAuditorRequests',
      'AccessContract.GetAuditorReview',
      'AccessContract.QueryDynamicAuthorizations',
      'AccessContract.GetDynamicAuthorizationHistory',
      'AccessContract.RevokeDynamicAuthorization',
      'AuditContract.GetRequestAuditTrail',
    ];
    const absent = required.filter((name) => !invoked.has(name));
    expect(absent, `DIAS methods no backend code calls: ${absent.join(', ')}`).to.deep.equal([]);
  });

  it('no longer calls the AI-organisation recommendation or model-registration methods', () => {
    const retired = [
      'GetAccessRequestForRecommendation', 'SubmitLLMRecommendation', 'RecordLLMRecommendationUnavailable',
      'VerifyRecommendationReason', 'RegisterRecommendationModel', 'ActivateRecommendationModel',
      'RegisterGovernancePolicyBundle', 'ActivateGovernancePolicyBundle',
    ];
    const found = calls
      .filter((call) => retired.includes(call.method))
      .map((call) => `${call.contract}.${call.method} in ${call.files.join(', ')}`);
    expect(found, `retired methods still called: ${found.join('; ')}`).to.deep.equal([]);
  });

  it('no longer calls any SEAL-era access method', () => {
    const retired = [
      'RequestAccess', 'GetAccessRequestForDecision', 'SubmitLLMDecision',
      'QueryDynamicAccessRules', 'GetDynamicAccessRuleHistory', 'RevokeDynamicAccessRule',
      'QueryPendingEscalations', 'ApproveEscalation', 'RejectEscalation', 'VerifyExplanation',
    ];
    const found = calls
      .filter((call) => retired.includes(call.method))
      .map((call) => `${call.contract}.${call.method} in ${call.files.join(', ')}`);
    expect(found, `retired methods still called: ${found.join('; ')}`).to.deep.equal([]);
  });
});
