/**
 * Frontend/backend route compatibility.
 *
 * The API client and the Express routers are two independently editable files
 * that agree only by convention. When the DIAS rewrite renamed the access
 * endpoints, nothing failed until a button was pressed in a browser. This test
 * extracts every path the client calls and every path the routers mount, and
 * fails when one names something the other does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

/** Express routers, in the order server.js mounts them. */
const ROUTERS = Object.freeze({
  auth: 'backend/src/routes/auth.js',
  records: 'backend/src/routes/records.js',
  access: 'backend/src/routes/access.js',
  audit: 'backend/src/routes/audit.js',
  users: 'backend/src/routes/users.js',
  cases: 'backend/src/routes/cases.js',
  departments: 'backend/src/routes/departments.js',
  explain: 'backend/src/routes/explain.js',
});

/**
 * `/access/auditor/${requestId}/decision` -> `/access/auditor/:/decision`
 *
 * A trailing `${query({...})}` builds a query string, which Express does not
 * route on, so it is dropped rather than turned into a path segment.
 */
function shape(pathname) {
  return pathname
    .replace(/\$\{query\([\s\S]*?\)\}/g, '')
    .replace(/\$\{[^}]*\}/g, ':')
    .replace(/:[A-Za-z0-9_]+/g, ':')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '') || '/';
}

/** Every request the client makes, as METHOD + normalised path. */
function clientCalls() {
  const source = read('frontend/js/core/api.js');
  const calls = [];
  for (const [, method, raw] of source.matchAll(/request\(\s*'(\w+)',\s*`([^`]+)`/g)) {
    calls.push({ method, path: shape(raw) });
  }
  for (const [, method, raw] of source.matchAll(/request\(\s*'(\w+)',\s*'([^']+)'/g)) {
    calls.push({ method, path: shape(raw) });
  }
  return calls;
}

/** Every route each router mounts, prefixed by its mount point. */
function serverRoutes() {
  const routes = [];
  for (const [mount, file] of Object.entries(ROUTERS)) {
    const source = read(file);
    for (const [, method, raw] of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      routes.push({ method: method.toUpperCase(), path: shape(`/${mount}${raw}`) });
    }
  }
  return routes;
}

test('every endpoint the client calls is mounted by a router', () => {
  const mounted = new Set(serverRoutes().map((r) => `${r.method} ${r.path}`));
  const missing = clientCalls()
    .map((c) => `${c.method} ${c.path}`)
    .filter((key) => !mounted.has(key));
  assert.deepEqual([...new Set(missing)], [],
    `client calls no router serves:\n  ${[...new Set(missing)].join('\n  ')}`);
});

test('the client exposes the DIAS access endpoints the workflow needs', () => {
  const called = new Set(clientCalls().map((c) => `${c.method} ${c.path}`));
  const required = [
    'POST /access/request',
    'GET /access/request/:',
    'GET /access/auditor/pending',
    'GET /access/auditor/:',
    'POST /access/auditor/:/decision',
    'GET /access/dynamic-authorizations',
    'GET /access/dynamic-authorizations/:/history',
    'POST /access/dynamic-authorizations/:/revoke',
    'GET /audit/request-trail/:',
  ];
  assert.deepEqual(required.filter((key) => !called.has(key)), []);
});

test('no SEAL-era access endpoint survives in the client', () => {
  const source = read('frontend/js/core/api.js');
  for (const retired of ['/access/llm-request', '/access/dynamic-rules', '/access/pending',
    '/approve', '/reject', '/audit/verify-explanation']) {
    assert.ok(!source.includes(retired), `client still calls ${retired}`);
  }
});
