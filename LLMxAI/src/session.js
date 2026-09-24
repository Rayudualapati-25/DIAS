'use strict';

const crypto = require('crypto');

const SESSION_COOKIE = 'llmxai_session';
const SESSION_TTL_MS = Number(process.env.LLMXAI_SESSION_TTL_MS || 30 * 60 * 1000);
const TOKEN_BYTES = 32;

// token -> frozen session record. Replaced, never mutated in place.
const store = new Map();

function newToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function sessionRecord(token, profileId, nowMs) {
  return Object.freeze({
    token,
    profileId,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + SESSION_TTL_MS,
  });
}

function createSession(profileId, nowMs = Date.now()) {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new Error('A session requires a registered profile identifier.');
  }
  const session = sessionRecord(newToken(), profileId, nowMs);
  store.set(session.token, session);
  return session;
}

function readSession(token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const session = store.get(token);
  if (!session) return null;
  if (session.expiresAtMs <= nowMs) {
    store.delete(token);
    return null;
  }
  return session;
}

// Sliding expiry without mutation: the old record is replaced by a new frozen one.
function renewSession(token, nowMs = Date.now()) {
  const session = readSession(token, nowMs);
  if (!session) return null;
  const renewed = sessionRecord(session.token, session.profileId, nowMs);
  store.set(renewed.token, renewed);
  return renewed;
}

function destroySession(token) {
  return typeof token === 'string' ? store.delete(token) : false;
}

function parseCookies(header) {
  if (typeof header !== 'string' || header.length === 0) return Object.freeze({});
  const entries = header.split(';').reduce((accumulated, part) => {
    const index = part.indexOf('=');
    if (index < 1) return accumulated;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name.length === 0) return accumulated;
    return accumulated.concat([[name, decodeURIComponent(value)]]);
  }, []);
  return Object.freeze(Object.fromEntries(entries));
}

function sessionCookie(token) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearedCookie,
  createSession,
  destroySession,
  parseCookies,
  readSession,
  renewSession,
  sessionCookie,
};
