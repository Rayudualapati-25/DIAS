'use strict';

/**
 * UserContract — the on-chain user registry.
 *
 * Enrolling with a Fabric CA issues an X.509 identity. It does NOT create the
 * application's authorization profile. CreateUser writes that profile to the
 * ledger so admission, role and status changes have Fabric history.
 *
 * A registered user therefore has an X.509 certificate issued by Fabric CA
 * and an authorization profile in this contract. No password or password hash
 * is accepted: secrets are not suitable for replicated, immutable state.
 *
 * Keys use the chaincode's composite-key convention ('user' namespace) so they
 * cannot collide with records or access decisions.
 */

const { Contract } = require('fabric-contract-api');
const { MSP, getCaller, requireMsp, requireRole } = require('./util/identity');
const { validateAllowList, SAFE_ID } = require('./util/validate');
const { putJson } = require('./util/state');
const { DISTRICT_HEAD_ROLES, ROLES } = require('./policy/policyV1');

const USER_KEY = 'user';

/** Department name -> MSP, so a user can only be filed under their own org. */
const ORG_TO_MSP = Object.freeze({
  police: MSP.POLICE,
  forensics: MSP.FORENSICS,
  prosecution: MSP.PROSECUTION,
  court: MSP.COURT,
  audit: MSP.AUDIT,
});

/**
 * Admitting a user to the network is an act of the district authority, not of the
 * department the user will work in. Every district head sits in the authority
 * organisation, so registration is restricted to a district-head rank there — no
 * station head and no working officer can create an identity.
 */

const CREDENTIAL_STATUS = Object.freeze(['active', 'revoked', 'suspended']);

const USER_SCHEMA = {
  displayName: { type: 'string', required: true },
  org: { type: 'string', required: true, enum: Object.keys(ORG_TO_MSP) },
  role: { type: 'string', required: true, enum: Object.values(ROLES) },
  fabricUser: { type: 'string', required: true, pattern: SAFE_ID },
  departmentId: { type: 'string', required: true, enum: Object.keys(ORG_TO_MSP) },
  rank: { type: 'string', required: false, pattern: SAFE_ID },
  station: { type: 'string', required: false, pattern: SAFE_ID },
  jurisdiction: { type: 'string', required: true, pattern: SAFE_ID },
  clearance: { type: 'string', required: true, enum: ['low', 'medium', 'high'] },
  caseAssignments: { type: 'stringArray', required: false, default: [] },
  credentialStatus: {
    type: 'string', required: false, enum: [...CREDENTIAL_STATUS], default: 'active',
  },
};

class UserContract extends Contract {
  constructor() {
    super('UserContract');
  }

  _userKey(ctx, userId) {
    return ctx.stub.createCompositeKey(USER_KEY, [userId]);
  }

  async _getUser(ctx, userId) {
    const data = await ctx.stub.getState(this._userKey(ctx, userId));
    if (!data || data.length === 0) {
      throw new Error(`user '${userId}' does not exist on the ledger`);
    }
    return JSON.parse(data.toString());
  }

  /** Throw unless the caller may administer users in `org`. */
  /** True only while the ledger holds no user at all. */
  async _ledgerHasNoUsers(ctx) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(USER_KEY, []);
    const first = await iterator.next();
    await iterator.close();
    return Boolean(first.done);
  }

  async _requireOrgAdmin(ctx, org, action) {
    const caller = getCaller(ctx);
    if (!ORG_TO_MSP[org]) {
      throw new Error(`unknown organisation '${org}'`);
    }
    // District heads of every department sit in the authority organisation and
    // are the only identities that may admit a user to any department.
    requireMsp(caller, [MSP.AUDIT], action);
    // Genesis: district heads are themselves users, so on an empty ledger nobody
    // could admit anyone. Exactly one admission is allowed to an administrator of
    // the authority organisation, and the exception closes the moment it is used.
    if (await this._ledgerHasNoUsers(ctx)) return caller;
    requireRole(caller, [...DISTRICT_HEAD_ROLES], action);
    return caller;
  }

  async UserExists(ctx, userId) {
    const data = await ctx.stub.getState(this._userKey(ctx, userId));
    return data !== null && data.length > 0;
  }

  /**
   * Admit a user to a department and write them onto the ledger.
   * The profile contains authorization attributes only, never a secret.
   */
  async CreateUser(ctx, userId, profileJson) {
    if (!SAFE_ID.test(userId)) {
      throw new Error('userId has invalid format');
    }

    let parsed;
    try {
      parsed = JSON.parse(profileJson);
    } catch (err) {
      throw new Error('profile must be valid JSON');
    }
    const profile = validateAllowList(parsed, USER_SCHEMA, 'user');

    const caller = await this._requireOrgAdmin(ctx, profile.org, 'CreateUser');
    if (profile.departmentId !== profile.org) {
      throw new Error('user departmentId must match org');
    }
    if (profile.caseAssignments.some((caseId) => !SAFE_ID.test(caseId))) {
      throw new Error('user caseAssignments contains an invalid identifier');
    }

    if (await this.UserExists(ctx, userId)) {
      throw new Error(`user '${userId}' already exists on the ledger`);
    }

    const user = {
      docType: 'user',
      userId,
      ...profile,
      // The enrolled certificate that admitted this user. Recorded so the
      // on-chain account is tied to a real, named Fabric identity rather than
      // to "the application".
      registeredBy: caller.id,
      registeredByMSP: caller.mspId,
      registeredAt: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };

    await putJson(ctx, this._userKey(ctx, userId), user);
    ctx.stub.setEvent('UserRegistered', Buffer.from(JSON.stringify({
      userId, org: user.org, role: user.role, registeredBy: caller.id,
    })));

    return JSON.stringify(user);
  }

  /** Read one public authorization profile. */
  async ReadUser(ctx, userId) {
    return JSON.stringify(await this._getUser(ctx, userId));
  }

  /**
   * Prove that the transaction is signed by the X.509 identity named in the
   * requested profile. This is the chain-backed login primitive: the MSP,
   * certificate common name, role attribute and ledger status must agree.
   */
  async AuthenticateCurrentUser(ctx, userId) {
    const user = await this._getUser(ctx, userId);
    const caller = getCaller(ctx);
    requireMsp(caller, [ORG_TO_MSP[user.org]], 'AuthenticateCurrentUser');

    if (caller.enrollmentId !== user.fabricUser) {
      throw new Error('unauthorized: certificate does not belong to this user');
    }
    if (caller.role !== user.role) {
      throw new Error('unauthorized: certificate role does not match ledger profile');
    }
    for (const attribute of ['rank', 'station', 'jurisdiction', 'clearance']) {
      if (user[attribute] && caller[attribute] !== user[attribute]) {
        throw new Error(`unauthorized: certificate ${attribute} does not match ledger profile`);
      }
    }
    if (user.credentialStatus !== 'active') {
      throw new Error(`unauthorized: account is ${user.credentialStatus}`);
    }
    return JSON.stringify(user);
  }

  /** Every authorization profile on the ledger. */
  async QueryAllUsers(ctx) {
    const iterator = await ctx.stub.getStateByPartialCompositeKey(USER_KEY, []);
    const users = [];
    let res = await iterator.next();
    while (!res.done) {
      users.push(JSON.parse(res.value.value.toString()));
      res = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(users);
  }

  /**
   * Revoke, suspend or reinstate a user. The record is never deleted: the
   * point of an on-chain registry is that admission and removal are both
   * permanently visible.
   */
  async SetUserStatus(ctx, userId, status) {
    if (!CREDENTIAL_STATUS.includes(status)) {
      throw new Error(
        `credentialStatus must be one of [${CREDENTIAL_STATUS.join(', ')}]`
      );
    }
    const user = await this._getUser(ctx, userId);
    const caller = await this._requireOrgAdmin(ctx, user.org, 'SetUserStatus');

    const updated = {
      ...user,
      credentialStatus: status,
      statusChangedBy: caller.id,
      statusChangedAt: ctx.stub.getDateTimestamp().toISOString(),
      txId: ctx.stub.getTxID(),
    };
    await putJson(ctx, this._userKey(ctx, userId), updated);
    ctx.stub.setEvent('UserStatusChanged', Buffer.from(JSON.stringify({
      userId, status, changedBy: caller.id,
    })));

    return JSON.stringify(updated);
  }

  /** Admission and status history for one user, straight from the ledger. */
  async GetUserHistory(ctx, userId) {
    const iterator = await ctx.stub.getHistoryForKey(this._userKey(ctx, userId));
    const history = [];
    let res = await iterator.next();
    while (!res.done) {
      history.push({
        txId: res.value.txId,
        isDelete: res.value.isDelete,
        value: res.value.value.length > 0
          ? JSON.parse(res.value.value.toString())
          : null,
      });
      res = await iterator.next();
    }
    await iterator.close();
    return JSON.stringify(history);
  }
}

module.exports = UserContract;
