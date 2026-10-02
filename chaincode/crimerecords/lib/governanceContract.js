'use strict';

/** Department and case assets for the first SEBA-XAI vertical slice. */

const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const { DISTRICT_HEAD_ROLES } = require('./policy/policyV1');
const { validateAllowList, SAFE_ID, sha256 } = require('./util/validate');
const { putJson } = require('./util/state');
const { ROLES } = require('./policy/policyV1');
const { requireActiveDistrictHead } = require('./dias/auditorAuthority');
const { actorFrom } = require('./dias/lifecycle');
const {
  PARAMETERS_ID, PARAMETERS_KEY, PARAMETERS_SCHEMA_VERSION, readParameters, validateParameters,
} = require('./dias/parameters');
const {
  ACTIVE_POLICY_KEY, ACTIVE_POLICY_SCHEMA_VERSION, POLICY_STATUS, POLICY_VERSION_KEY,
  POLICY_VERSION_SCHEMA_VERSION, activeKey, assertPolicyHash, assertPolicyVersion,
  readActivePolicy, readPolicyVersion, versionKey,
} = require('./dias/policyRegistry');

const DEPARTMENT_KEY = 'department';
const CASE_KEY = 'case';
const CASE_WORKFLOW_KEY = 'caseWorkflow';

const ORG_TO_MSP = Object.freeze({
  police: MSP.POLICE,
  forensics: MSP.FORENSICS,
  prosecution: MSP.PROSECUTION,
  court: MSP.COURT,
  audit: MSP.AUDIT,
});

const DEPARTMENT_SCHEMA = {
  name: { type: 'string', required: true },
  type: {
    type: 'string', required: true,
    enum: ['police', 'forensics', 'prosecution', 'court', 'oversight'],
  },
  jurisdiction: { type: 'string', required: true, pattern: SAFE_ID },
  status: { type: 'string', required: false, enum: ['active', 'suspended'], default: 'active' },
  permittedFunctions: { type: 'stringArray', required: true },
};

const CASE_SCHEMA = {
  owningAgency: { type: 'string', required: true, enum: Object.keys(ORG_TO_MSP) },
  jurisdiction: { type: 'string', required: true, pattern: SAFE_ID },
  status: {
    type: 'string', required: false,
    enum: ['open', 'under-investigation', 'filed-to-court', 'closed'], default: 'open',
  },
  assignedUsers: { type: 'stringArray', required: false, default: [] },
  protectedClassifications: { type: 'stringArray', required: false, default: [] },
};

const CASE_PROTECTIONS = new Set(['juvenile', 'witness', 'victim', 'sealed']);

class GovernanceContract extends Contract {
  constructor() {
    super('GovernanceContract');
  }

  _key(ctx, type, id) {
    return ctx.stub.createCompositeKey(type, [id]);
  }

  async _read(ctx, type, id, label) {
    const data = await ctx.stub.getState(this._key(ctx, type, id));
    if (!data || data.length === 0) throw new Error(`${label} '${id}' does not exist`);
    return JSON.parse(data.toString());
  }

  async CreateDepartment(ctx, departmentId, profileJson) {
    if (!SAFE_ID.test(departmentId) || !ORG_TO_MSP[departmentId]) {
      throw new Error('departmentId must be a known agency identifier');
    }
    // Station and district heads sit in the authority organisation, so no
    // department holds a senior enough rank to register itself. Registering a
    // department is an act of the district authority, like admitting a user.
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.AUDIT], 'CreateDepartment');
    requireRole(caller, [...DISTRICT_HEAD_ROLES], 'CreateDepartment');
    const key = this._key(ctx, DEPARTMENT_KEY, departmentId);
    const existing = await ctx.stub.getState(key);
    if (existing && existing.length > 0) {
      throw new Error(`department '${departmentId}' already exists`);
    }
    const profile = validateAllowList(
      JSON.parse(profileJson), DEPARTMENT_SCHEMA, 'department'
    );
    const department = {
      docType: 'department', departmentId, ...profile,
      // Owned by the department it describes, not by the authority that
      // registered it — the registrar is recorded separately.
      owningMsp: ORG_TO_MSP[departmentId],
      registeredByMsp: caller.mspId,
      registeredByRole: caller.role,
      createdAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, key, department);
    ctx.stub.setEvent('DepartmentCreated', Buffer.from(JSON.stringify({ departmentId })));
    return JSON.stringify(department);
  }

  async ReadDepartment(ctx, departmentId) {
    return JSON.stringify(await this._read(ctx, DEPARTMENT_KEY, departmentId, 'department'));
  }

  async QueryDepartments(ctx) {
    return this._queryAll(ctx, DEPARTMENT_KEY);
  }

  async CreateCase(ctx, caseId, caseJson) {
    if (!SAFE_ID.test(caseId)) throw new Error('caseId has invalid format');
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.POLICE], 'CreateCase');
    requireRole(caller, [
      ROLES.SUB_INSPECTOR, ROLES.INSPECTOR, ROLES.CIRCLE_INSPECTOR, ROLES.INVESTIGATING_OFFICER,
    ], 'CreateCase');
    const key = this._key(ctx, CASE_KEY, caseId);
    const existing = await ctx.stub.getState(key);
    if (existing && existing.length > 0) throw new Error(`case '${caseId}' already exists`);

    const input = validateAllowList(JSON.parse(caseJson), CASE_SCHEMA, 'case');
    requireMsp(caller, [ORG_TO_MSP[input.owningAgency]], 'CreateCase');
    if (input.assignedUsers.some((id) => !SAFE_ID.test(id))) {
      throw new Error('case: assignedUsers contains an invalid identifier');
    }
    const invalidProtection = input.protectedClassifications
      .find((value) => !CASE_PROTECTIONS.has(value));
    if (invalidProtection) {
      throw new Error(`case: unsupported protected classification '${invalidProtection}'`);
    }
    const caseAsset = {
      docType: 'case', caseId, ...input,
      createdByIdentity: caller.id,
      createdAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, key, caseAsset);
    ctx.stub.setEvent('CaseCreated', Buffer.from(JSON.stringify({ caseId })));
    return JSON.stringify(caseAsset);
  }

  async ReadCase(ctx, caseId) {
    return JSON.stringify(await this._read(ctx, CASE_KEY, caseId, 'case'));
  }

  async QueryCases(ctx) {
    return this._queryAll(ctx, CASE_KEY);
  }

  async AssignCaseUser(ctx, caseId, userId) {
    if (!SAFE_ID.test(userId)) throw new Error('userId has invalid format');
    const caller = getCaller(ctx);
    requireMsp(caller, [MSP.POLICE], 'AssignCaseUser');
    requireRole(caller, [ROLES.CIRCLE_INSPECTOR, ROLES.INSPECTOR], 'AssignCaseUser');
    const caseAsset = await this._read(ctx, CASE_KEY, caseId, 'case');
    const assignedUsers = [...new Set([...caseAsset.assignedUsers, userId])];
    const updated = {
      ...caseAsset, assignedUsers,
      assignmentChangedAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, this._key(ctx, CASE_KEY, caseId), updated);
    ctx.stub.setEvent('CaseAssignmentChanged', Buffer.from(JSON.stringify({ caseId, userId })));
    return JSON.stringify(updated);
  }

  /** Prosecution/court lifecycle metadata; raw filings remain off-chain. */
  async AdvanceCaseWorkflow(ctx, caseId, nextStatus, reference, note) {
    const caller = getCaller(ctx);
    const caseAsset = await this._read(ctx, CASE_KEY, caseId, 'case');
    if (!SAFE_ID.test(reference || '')) throw new Error('workflow reference is required');
    if (nextStatus === 'filed-to-court') {
      requireMsp(caller, [MSP.POLICE, MSP.PROSECUTION], 'AdvanceCaseWorkflow');
      requireRole(caller, [ROLES.CIRCLE_INSPECTOR, ROLES.PUBLIC_PROSECUTOR], 'AdvanceCaseWorkflow');
    } else if (nextStatus === 'closed') {
      requireMsp(caller, [MSP.COURT], 'AdvanceCaseWorkflow');
      requireRole(caller, [ROLES.JUDGE, ROLES.MAGISTRATE], 'AdvanceCaseWorkflow');
      if (caseAsset.status !== 'filed-to-court') {
        throw new Error('case must be filed to court before it can be closed');
      }
    } else {
      throw new Error("nextStatus must be 'filed-to-court' or 'closed'");
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const event = {
      docType: 'caseWorkflowEvent', caseId, fromStatus: caseAsset.status, nextStatus,
      reference, note: String(note || '').slice(0, 500),
      actorIdentity: caller.id, actorMsp: caller.mspId, actorRole: caller.role,
      timestamp, txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, this._key(ctx, CASE_KEY, caseId), {
        ...caseAsset, status: nextStatus, workflowReference: reference,
        workflowChangedAtUtc: timestamp, txId: event.txId,
      });
    await putJson(ctx, ctx.stub.createCompositeKey(CASE_WORKFLOW_KEY, [caseId, timestamp, event.txId]), event);
    ctx.stub.setEvent('CaseWorkflowAdvanced', Buffer.from(JSON.stringify({
      caseId, nextStatus, reference,
    })));
    return JSON.stringify(event);
  }

  async QueryCaseWorkflow(ctx, caseId) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(CASE_WORKFLOW_KEY, [caseId]);
    const items = [];
    let result = await iterator.next();
    while (!result.done) {
      items.push(JSON.parse(result.value.value.toString()));
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(items);
  }

  /**
   * DIAS workflow parameters (design §8). Set by an active AuditMSP district
   * head; each change is a new state version with its author and transaction.
   */
  async SetDiasParameters(ctx, parametersJson) {
    const { caller } = await requireActiveDistrictHead(ctx, { action: 'SetDiasParameters' });
    let input;
    try {
      input = JSON.parse(parametersJson);
    } catch (_error) {
      throw new Error('DIAS parameters must be valid JSON');
    }
    const parameters = validateParameters(input);
    const stored = {
      docType: PARAMETERS_KEY,
      schemaVersion: PARAMETERS_SCHEMA_VERSION,
      ...parameters,
      setBy: actorFrom(caller, sha256(caller.id)),
      setAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, ctx.stub.createCompositeKey(PARAMETERS_KEY, [PARAMETERS_ID]), stored);
    ctx.stub.setEvent('DiasParametersChanged', Buffer.from(JSON.stringify({
      pendingReviewTtlSeconds: parameters.pendingReviewTtlSeconds,
    })));
    return JSON.stringify(stored);
  }

  async GetDiasParameters(ctx) {
    return JSON.stringify(await readParameters(ctx));
  }

  /**
   * Register a governance policy version by the digest of its canonical bundle
   * (design §5). The policy text never reaches the ledger.
   */
  async RegisterPolicyVersion(ctx, policyVersion, policyHash, bundleId) {
    const { caller } = await requireActiveDistrictHead(ctx, { action: 'RegisterPolicyVersion' });
    assertPolicyVersion(policyVersion);
    assertPolicyHash(policyHash);
    if (!SAFE_ID.test(bundleId || '')) throw new Error('bundleId has invalid format');
    if (await readPolicyVersion(ctx, policyVersion)) {
      throw new Error(`policy version '${policyVersion}' is already registered`);
    }
    const identityHash = sha256(caller.id);
    const record = {
      docType: POLICY_VERSION_KEY,
      schemaVersion: POLICY_VERSION_SCHEMA_VERSION,
      policyVersion,
      policyHash,
      bundleId,
      status: POLICY_STATUS.REGISTERED,
      registeredBy: actorFrom(caller, identityHash),
      registeredAtUtc: ctx.stub.getDateTimestamp().toISOString(),
      registrationTxId: ctx.stub.getTxID(),
      activatedBy: null,
      activatedAtUtc: null,
      activationTxId: null,
      retiredAtUtc: null,
      retirementTxId: null,
    };
    await putJson(ctx, versionKey(ctx, policyVersion), record);
    ctx.stub.setEvent('DiasPolicyRegistered', Buffer.from(JSON.stringify({ policyVersion, policyHash })));
    return JSON.stringify(record);
  }

  /**
   * Make a registered version the active policy. A second district head must do
   * it (two-person rule, design D-02); the previous version is retired for good.
   */
  async ActivatePolicyVersion(ctx, policyVersion) {
    const { caller } = await requireActiveDistrictHead(ctx, { action: 'ActivatePolicyVersion' });
    assertPolicyVersion(policyVersion);
    const version = await readPolicyVersion(ctx, policyVersion);
    if (!version) throw new Error(`policy version '${policyVersion}' is not registered`);
    if (version.status !== POLICY_STATUS.REGISTERED) {
      throw new Error(`policy version '${policyVersion}' is ${version.status}; only a registered version can be activated`);
    }
    const identityHash = sha256(caller.id);
    if (version.registeredBy.identityHash === identityHash) {
      throw new Error('a policy version must be activated by a different district head than the one who registered it');
    }
    const timestamp = ctx.stub.getDateTimestamp().toISOString();
    const txId = ctx.stub.getTxID();
    const previous = await readActivePolicy(ctx);
    if (previous) {
      const retiring = await readPolicyVersion(ctx, previous.policyVersion);
      await putJson(ctx, versionKey(ctx, previous.policyVersion), {
        ...retiring, status: POLICY_STATUS.RETIRED, retiredAtUtc: timestamp, retirementTxId: txId,
      });
    }
    const actor = actorFrom(caller, identityHash);
    await putJson(ctx, versionKey(ctx, policyVersion), {
      ...version, status: POLICY_STATUS.ACTIVE, activatedBy: actor, activatedAtUtc: timestamp, activationTxId: txId,
    });
    const active = {
      docType: ACTIVE_POLICY_KEY,
      schemaVersion: ACTIVE_POLICY_SCHEMA_VERSION,
      policyVersion,
      policyHash: version.policyHash,
      bundleId: version.bundleId,
      activationSeq: previous ? previous.activationSeq + 1 : 1,
      previousPolicyVersion: previous ? previous.policyVersion : null,
      activatedBy: actor,
      activatedAtUtc: timestamp,
      activationTxId: txId,
    };
    await putJson(ctx, activeKey(ctx), active);
    ctx.stub.setEvent('DiasPolicyActivated', Buffer.from(JSON.stringify({
      policyVersion, policyHash: version.policyHash,
    })));
    return JSON.stringify(active);
  }

  async GetActivePolicy(ctx) {
    return JSON.stringify(await readActivePolicy(ctx));
  }

  async QueryPolicyVersions(ctx) {
    return this._queryAll(ctx, POLICY_VERSION_KEY);
  }

  async _queryAll(ctx, type) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(type, []);
    const items = [];
    let result = await iterator.next();
    while (!result.done) {
      items.push(JSON.parse(result.value.value.toString()));
      result = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(items);
  }
}

module.exports = GovernanceContract;
