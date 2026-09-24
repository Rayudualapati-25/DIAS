'use strict';

/**
 * PolicyContextProvider — assembles the governance policy context for one
 * verified request from the canonical bundle.
 *
 * Every clause in policy v1 is global and mandatory, and the complete bundle fits
 * comfortably in the model context, so no retrieval is used: the provider supplies
 * the complete applicable bundle and narrows only the RBAC matrix to the
 * requester's role. A retrieval-backed provider can later implement the same
 * `assemble` interface. Dynamic authorizations are never part of policy context.
 */

const { hashObject, loadBundle } = require('../../../policies/lib/bundle');

const POLICY_CONTEXT_SCHEMA_VERSION = 'dias-policy-context-v1';
const SELECTION_METHOD = 'complete-applicable-bundle';

class PolicyContextUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyContextUnavailableError';
    this.generationStatus = 'POLICY_CONTEXT_UNAVAILABLE';
  }
}

function createPolicyContextProvider({ bundlePath, loader = loadBundle } = {}) {
  let loaded = null;

  function current() {
    if (loaded) return loaded;
    try {
      loaded = loader(bundlePath);
    } catch (error) {
      throw new PolicyContextUnavailableError(error.message);
    }
    return loaded;
  }

  function bundleInfo() {
    const { bundle, bundleHash, clauseRefs } = current();
    return Object.freeze({
      bundleId: bundle.bundleId,
      version: bundle.version,
      bundleHash,
      clauseRefs: [...clauseRefs],
      reasonCodes: { ...bundle.reasonCodes },
      reviewFlags: Object.keys(bundle.reviewFlags),
    });
  }

  function assemble(verifiedRequest) {
    const { bundle, bundleHash } = current();
    const role = verifiedRequest?.requester?.role;
    if (typeof role !== 'string') {
      throw new PolicyContextUnavailableError('verified request has no requester role');
    }
    const context = {
      schemaVersion: POLICY_CONTEXT_SCHEMA_VERSION,
      selection: SELECTION_METHOD,
      bundleId: bundle.bundleId,
      version: bundle.version,
      bundleHash,
      clauses: bundle.clauses.map((clause) => ({
        ref: `${clause.policyId}:${clause.clauseId}@${bundle.version}`,
        title: clause.title,
        effect: clause.effect,
        reasonCode: clause.reasonCode,
        text: clause.text,
      })),
      precedence: bundle.precedence,
      requesterRole: {
        role,
        organization: bundle.roles[role] ? bundle.roles[role].organization : null,
        permissions: bundle.rbac[role] || {},
      },
      organizationsByMsp: bundle.vocabularies.organizationsByMsp,
      roleLists: bundle.roleLists,
      purposes: bundle.vocabularies.purposes,
      clearanceOrder: bundle.vocabularies.clearanceOrder,
      unknownSensitivityTreatedAs: bundle.vocabularies.unknownSensitivityTreatedAs,
      reasonCodes: bundle.reasonCodes,
      reviewFlags: bundle.reviewFlags,
      missingEvidence: bundle.missingEvidence,
    };
    return Object.freeze({ ...context, contextHash: hashObject(context) });
  }

  return Object.freeze({ assemble, bundleInfo });
}

module.exports = {
  POLICY_CONTEXT_SCHEMA_VERSION,
  PolicyContextUnavailableError,
  SELECTION_METHOD,
  createPolicyContextProvider,
};
