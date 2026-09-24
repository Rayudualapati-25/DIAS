'use strict';

/**
 * User accounts, read from and written to the ledger.
 *
 * There is no users table and no application password store. Fabric CA issues
 * the X.509 identity; UserContract holds its authorization profile and status.
 *
 * The fixed audit identity performs the initial public lookup. The selected
 * user's own certificate must then successfully call AuthenticateCurrentUser.
 */

const { evaluate, submit } = require('./gateway');
const { AUTH_ORG, AUTH_USER } = require('../config');

const CONTRACT = 'UserContract';
/** Locate the public authorization profile before selecting its MSP identity. */
async function readForLogin(username) {
  try {
    return await evaluate(AUTH_ORG, AUTH_USER, CONTRACT, 'ReadUser', username);
  } catch (err) {
    if (String(err.message || err).includes('does not exist')) return undefined;
    throw err;
  }
}

/** Prove that the backend has the selected enrolled identity and that its
 * certificate attributes still match the active ledger profile. */
function authenticate(org, fabricUser, username) {
  return evaluate(org, fabricUser, CONTRACT, 'AuthenticateCurrentUser', username);
}

/** Public view of one account — never includes the credential. */
function read(org, fabricUser, username) {
  return evaluate(org, fabricUser, CONTRACT, 'ReadUser', username);
}

/** Every account on the ledger, as seen by the given caller. */
function list(org, fabricUser) {
  return evaluate(org, fabricUser, CONTRACT, 'QueryAllUsers');
}

/**
 * Write a new account onto the ledger, signed by the officer admitting them.
 * The chaincode enforces that this officer holds an administrative role in the
 * department they are registering into.
 */
function create(org, fabricUser, userId, profile) {
  return submit(org, fabricUser, CONTRACT, 'CreateUser', userId, JSON.stringify(profile));
}

/** Revoke, suspend or reinstate an account. The record is never deleted. */
function setStatus(org, fabricUser, userId, status) {
  return submit(org, fabricUser, CONTRACT, 'SetUserStatus', userId, status);
}

/** Admission and status history straight from the key's ledger history. */
function history(org, fabricUser, userId) {
  return evaluate(org, fabricUser, CONTRACT, 'GetUserHistory', userId);
}

module.exports = {
  readForLogin, authenticate, read, list, create, setStatus, history,
};
