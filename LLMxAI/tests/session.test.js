'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearedCookie,
  createSession,
  destroySession,
  parseCookies,
  readSession,
  renewSession,
  sessionCookie,
} = require('../src/session');

test('a session binds one registered profile and is readable by token', () => {
  const session = createSession('user-sharma');
  assert.equal(session.profileId, 'user-sharma');
  assert.ok(session.token.length >= 32);
  assert.equal(readSession(session.token).profileId, 'user-sharma');
});

test('a session requires a profile identifier', () => {
  assert.throws(() => createSession(''), /registered profile/);
});

test('an expired session is unreadable and discarded', () => {
  const session = createSession('user-singh');
  assert.equal(readSession(session.token, session.expiresAtMs), null);
  assert.equal(readSession(session.token), null);
});

test('renewal extends expiry without mutating the stored record', () => {
  const session = createSession('user-patel');
  const laterMs = session.createdAtMs + 1000;
  const renewed = renewSession(session.token, laterMs);
  assert.equal(renewed.expiresAtMs, laterMs + SESSION_TTL_MS);
  assert.ok(Object.isFrozen(session));
  assert.equal(session.expiresAtMs, session.createdAtMs + SESSION_TTL_MS);
});

test('an unknown or destroyed token yields no session', () => {
  const session = createSession('user-iyer');
  assert.equal(destroySession(session.token), true);
  assert.equal(readSession(session.token), null);
  assert.equal(readSession('not-a-real-token'), null);
  assert.equal(readSession(undefined), null);
});

test('cookies parse into a frozen map and the session cookie is not script readable', () => {
  const parsed = parseCookies(`${SESSION_COOKIE}=abc123; theme=dark`);
  assert.equal(parsed[SESSION_COOKIE], 'abc123');
  assert.ok(Object.isFrozen(parsed));
  assert.deepEqual(parseCookies(undefined), {});

  const header = sessionCookie('abc123');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(clearedCookie(), /Max-Age=0/);
});
