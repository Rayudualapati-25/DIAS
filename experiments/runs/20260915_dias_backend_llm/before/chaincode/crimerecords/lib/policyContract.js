'use strict';

/**
 * PolicyContract — governance policy bundles and recommendation model registrations.
 *
 * Registering and activating the governance policy bundle, and the model allowed to
 * attest DIAS recommendations, are governance acts of an AuditMSP district head.
 * Registrations are never overwritten; activation moves a pointer, so an earlier
 * bundle or model can be re-activated (rollback) and key history keeps the record.
 * This contract stores policy content and identifiers; it never evaluates policy.
 */

const crypto = require('crypto');
const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const {
  SAFE_ID, SHA256_HEX, canonicalize, hashObject, sha256, validateAllowList,
} = require('./util/validate');
const { putJson } = require('./util/state');
const { DISTRICT_HEAD_ROLES } = require('./policy/policyV1');
const KEYS = require('./dias/keys');
const { RESPONSE_SCHEMA_VERSION } = require('./dias/recommendationSchema');

const CLAUSE_REF = /^GP-[A-Z]+:C[0-9]+@v[0-9]+$/;
const BUNDLE_VERSION = /^v[0-9]+$/;
const MAX_BUNDLE_BYTES = 200000;
const REGISTRATION_PURPOSES = Object.freeze(['research-baseline', 'fine-tuned-candidate', 'fixture-test']);

const REGISTRATION_SCHEMA = Object.freeze({
  modelId: { type: 'string', required: true, pattern: SAFE_ID },
  modelFamily: { type: 'string', required: true, pattern: SAFE_ID },
  baseModel: { type: 'string', required: true, pattern: /^[A-Za-z0-9._/-]{1,128}$/ },
  baseModelRevision: { type: 'string', required: true, pattern: SAFE_ID },
  quantization: { type: 'string', required: true, pattern: SAFE_ID },
  adapterId: { type: 'string', required: false, pattern: SAFE_ID },
  adapterHash: { type: 'string', required: false, pattern: SHA256_HEX },
  promptVersion: { type: 'string', required: true, pattern: SAFE_ID },
  responseSchemaVersion: { type: 'string', required: true, enum: [RESPONSE_SCHEMA_VERSION] },
  registrationPurpose: { type: 'string', required: true, enum: [...REGISTRATION_PURPOSES] },
});

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`${label} must be valid JSON`);
  }
}

/** Identifiers the DIAS contracts need from a bundle, with its canonical hash. */
function bundleSummary(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('policy bundle must be a JSON object');
  }
  if (!SAFE_ID.test(bundle.bundleId || '')) throw new Error('policy bundleId has invalid format');
  if (!BUNDLE_VERSION.test(bundle.version || '')) throw new Error('policy bundle version must look like v1');
  if (!Array.isArray(bundle.clauses) || bundle.clauses.length === 0) {
    throw new Error('policy bundle must contain clauses');
  }
  const clauseRefs = bundle.clauses.map(
    (clause) => `${clause.policyId}:${clause.clauseId}@${bundle.version}`
  );
  if (clauseRefs.some((ref) => !CLAUSE_REF.test(ref)) || new Set(clauseRefs).size !== clauseRefs.length) {
    throw new Error('policy bundle clause references are invalid or duplicated');
  }
  const reasonCodes = bundle.reasonCodes;
  if (!reasonCodes || typeof reasonCodes !== 'object' || Array.isArray(reasonCodes)
      || Object.values(reasonCodes).some((effect) => !['ALLOW', 'DENY'].includes(effect))) {
    throw new Error('policy bundle reasonCodes must map each code to ALLOW or DENY');
  }
  if (!bundle.reviewFlags || typeof bundle.reviewFlags !== 'object' || Array.isArray(bundle.reviewFlags)) {
    throw new Error('policy bundle reviewFlags must be an object');
  }
  const denyOrder = bundle.precedence && bundle.precedence.denyOrder;
  if (!Array.isArray(denyOrder) || denyOrder.some((ref) => !clauseRefs.includes(ref))) {
    throw new Error('policy bundle precedence must reference defined clauses');
  }
  return {
    bundleId: bundle.bundleId,
    version: bundle.version,
    schemaVersion: bundle.schemaVersion || null,
    bundleHash: hashObject(bundle),
    clauseRefs,
    reasonCodes: { ...reasonCodes },
    reviewFlags: Object.keys(bundle.reviewFlags),
  };
}

class PolicyContract extends Contract {
  constructor() {
    super('PolicyContract');
  }

  _requirePolicyAdmin(ctx, action) {
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.AUDIT], action);
    requireRole(caller, [...DISTRICT_HEAD_ROLES], action);
    return caller;
  }

  async _read(ctx, key) {
    const data = await ctx.stub.getState(key);
    return data && data.length > 0 ? JSON.parse(data.toString()) : null;
  }

  _actor(caller) {
    return {
      username: caller.enrollmentId || null,
      mspId: caller.mspId,
      role: caller.role,
      identityHash: sha256(caller.id),
    };
  }

  async _scan(ctx, keyType) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(keyType, []);
    const items = [];
    let result = await iterator.next();
    while (!result.done) {
      items.push(JSON.parse(result.value.value.toString()));
      result = await iterator.next();
    }
    await iterator.close();
    return items;
  }

  /** Register the complete governance policy bundle; its hash is computed on-chain. */
  async RegisterGovernancePolicyBundle(ctx, bundleJson) {
    const caller = this._requirePolicyAdmin(ctx, 'RegisterGovernancePolicyBundle');
    if (typeof bundleJson !== 'string' || Buffer.byteLength(bundleJson, 'utf8') > MAX_BUNDLE_BYTES) {
      throw new Error(`policy bundle must be JSON of at most ${MAX_BUNDLE_BYTES} bytes`);
    }
    const bundle = parseJson(bundleJson, 'policy bundle');
    const summary = bundleSummary(bundle);
    const key = ctx.stub.createCompositeKey(KEYS.POLICY_BUNDLE, [summary.bundleId, summary.version]);
    if (await this._read(ctx, key)) {
      throw new Error(`policy bundle '${summary.bundleId}' ${summary.version} is already registered`);
    }
    const registration = {
      docType: KEYS.POLICY_BUNDLE,
      ...summary,
      status: 'registered',
      canonicalBundle: canonicalize(bundle),
      registeredBy: this._actor(caller),
      registeredAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      registrationTxId: ctx.stub.getTxID(),
    };
    await putJson(ctx, key, registration);
    ctx.stub.setEvent('GovernancePolicyBundleRegistered', Buffer.from(JSON.stringify({
      bundleId: summary.bundleId, version: summary.version, bundleHash: summary.bundleHash,
    })));
    const { canonicalBundle, ...visible } = registration;
    return JSON.stringify(visible);
  }

  async ActivateGovernancePolicyBundle(ctx, bundleId, version) {
    const caller = this._requirePolicyAdmin(ctx, 'ActivateGovernancePolicyBundle');
    const key = ctx.stub.createCompositeKey(KEYS.POLICY_BUNDLE, [bundleId, version]);
    const registration = await this._read(ctx, key);
    if (!registration) throw new Error(`policy bundle '${bundleId}' ${version} is not registered`);
    const previous = await this._read(ctx, KEYS.ACTIVE_POLICY_BUNDLE);
    if (previous && previous.bundleId === bundleId && previous.version === version) {
      throw new Error(`policy bundle '${bundleId}' ${version} is already active`);
    }
    if (previous) {
      const previousKey = ctx.stub.createCompositeKey(KEYS.POLICY_BUNDLE, [previous.bundleId, previous.version]);
      const previousRegistration = await this._read(ctx, previousKey);
      if (previousRegistration) {
        await putJson(ctx, previousKey, {
          ...previousRegistration, status: 'superseded', supersededBy: `${bundleId}@${version}`,
        });
      }
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    await putJson(ctx, key, { ...registration, status: 'active', activatedAtUtc: timestamp });
    const { canonicalBundle, ...summary } = registration;
    const active = {
      ...summary,
      docType: KEYS.ACTIVE_POLICY_BUNDLE,
      status: 'active',
      previous: previous ? { bundleId: previous.bundleId, version: previous.version } : null,
      activatedBy: this._actor(caller),
      activatedAtUtc: timestamp,
      activationTxId: ctx.stub.getTxID(),
    };
    await putJson(ctx, KEYS.ACTIVE_POLICY_BUNDLE, active);
    ctx.stub.setEvent('GovernancePolicyBundleActivated', Buffer.from(JSON.stringify({
      bundleId, version, bundleHash: registration.bundleHash,
    })));
    return JSON.stringify(active);
  }

  async GetActiveGovernancePolicyBundle(ctx) {
    return JSON.stringify(await this._read(ctx, KEYS.ACTIVE_POLICY_BUNDLE));
  }

  async GetGovernancePolicyBundle(ctx, bundleId, version) {
    const registration = await this._read(
      ctx, ctx.stub.createCompositeKey(KEYS.POLICY_BUNDLE, [bundleId, version])
    );
    if (!registration) throw new Error(`policy bundle '${bundleId}' ${version} is not registered`);
    return JSON.stringify(registration);
  }

  async QueryGovernancePolicyBundles(ctx) {
    const items = await this._scan(ctx, KEYS.POLICY_BUNDLE);
    return JSON.stringify(items.map(({ canonicalBundle, ...summary }) => summary));
  }

  /** Register a model build allowed to attest recommendations (base, fine-tuned, or fixture). */
  async RegisterRecommendationModel(ctx, registrationJson, publicKeyPem) {
    const caller = this._requirePolicyAdmin(ctx, 'RegisterRecommendationModel');
    const fields = validateAllowList(
      parseJson(registrationJson, 'model registration'), REGISTRATION_SCHEMA, 'model registration'
    );
    if ((fields.adapterId === null) !== (fields.adapterHash === null)) {
      throw new Error('adapterId and adapterHash must both be set or both be empty');
    }
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 5000) {
      throw new Error('publicKeyPem is invalid');
    }
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(publicKeyPem);
    } catch (_error) {
      throw new Error('publicKeyPem is invalid');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('publicKeyPem must contain an Ed25519 public key');
    }
    const normalizedKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const registrationId = `MODEL-${ctx.stub.getTxID().slice(0, 16)}`;
    const registration = {
      docType: KEYS.MODEL_REGISTRATION,
      registrationId,
      ...fields,
      publicKeyPem: normalizedKey,
      publicKeyHash: sha256(normalizedKey),
      status: 'registered',
      registeredBy: this._actor(caller),
      registeredAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      registrationTxId: ctx.stub.getTxID(),
    };
    await putJson(ctx, ctx.stub.createCompositeKey(KEYS.MODEL_REGISTRATION, [registrationId]), registration);
    ctx.stub.setEvent('RecommendationModelRegistered', Buffer.from(JSON.stringify({
      registrationId, modelId: fields.modelId, adapterHash: fields.adapterHash,
    })));
    return JSON.stringify(registration);
  }

  async ActivateRecommendationModel(ctx, registrationId) {
    const caller = this._requirePolicyAdmin(ctx, 'ActivateRecommendationModel');
    if (!SAFE_ID.test(registrationId || '')) throw new Error('registrationId has invalid format');
    const key = ctx.stub.createCompositeKey(KEYS.MODEL_REGISTRATION, [registrationId]);
    const registration = await this._read(ctx, key);
    if (!registration) throw new Error(`model registration '${registrationId}' does not exist`);
    const previous = await this._read(ctx, KEYS.ACTIVE_MODEL);
    if (previous && previous.registrationId === registrationId) {
      throw new Error(`model registration '${registrationId}' is already active`);
    }
    if (previous) {
      const previousKey = ctx.stub.createCompositeKey(KEYS.MODEL_REGISTRATION, [previous.registrationId]);
      const previousRegistration = await this._read(ctx, previousKey);
      if (previousRegistration) {
        await putJson(ctx, previousKey, { ...previousRegistration, status: 'inactive' });
      }
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    await putJson(ctx, key, { ...registration, status: 'active', lastActivatedAtUtc: timestamp });
    const active = {
      ...registration,
      docType: KEYS.ACTIVE_MODEL,
      status: 'active',
      previousRegistrationId: previous ? previous.registrationId : null,
      activatedBy: this._actor(caller),
      activatedAtUtc: timestamp,
      activationTxId: ctx.stub.getTxID(),
    };
    await putJson(ctx, KEYS.ACTIVE_MODEL, active);
    ctx.stub.setEvent('RecommendationModelActivated', Buffer.from(JSON.stringify({
      registrationId, modelId: registration.modelId, previousRegistrationId: active.previousRegistrationId,
    })));
    return JSON.stringify(active);
  }

  async GetActiveRecommendationModel(ctx) {
    return JSON.stringify(await this._read(ctx, KEYS.ACTIVE_MODEL));
  }

  async QueryRecommendationModels(ctx) {
    return JSON.stringify(await this._scan(ctx, KEYS.MODEL_REGISTRATION));
  }
}

module.exports = PolicyContract;
module.exports.bundleSummary = bundleSummary;
