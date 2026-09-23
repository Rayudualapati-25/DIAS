'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { checkModel, decide } = require('./modelClient');
const { ORDERED_RULES, MODEL_VERSION, POLICY_VERSION } = require('./policy');
const {
  directory,
  findProfile,
  findResource,
  modelSubject,
  recordIdentifiers,
  resolveRecordFromQuery,
  resources,
} = require('./registry');
const {
  clearedCookie,
  createSession,
  destroySession,
  parseCookies,
  readSession,
  renewSession,
  sessionCookie,
  SESSION_COOKIE,
} = require('./session');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
const PORT = Number(process.env.PORT || 3002);
const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 2000;
const MAX_BODY_BYTES = 32768;

const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
});

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(`${JSON.stringify(body)}\n`);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error('Request body is too large.');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch (_error) {
    throw new Error('Request body must be valid JSON.');
  }
}

// The signed-in identity is the ONLY source of subject attributes. Nothing the
// browser sends in the request body can select or change who the requester is.
function authenticate(req) {
  const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  const session = renewSession(token);
  if (!session) return null;
  const profile = findProfile(session.profileId);
  return profile ? { session, profile } : null;
}

function requireSession(req, res) {
  const authenticated = authenticate(req);
  if (!authenticated) {
    json(res, 401, {
      error: 'Sign in to submit a request.',
      safetyDecision: 'escalate',
      explanation: 'No authenticated identity is bound to this request, so no decision was made.',
    });
    return null;
  }
  return authenticated;
}

function validateQuery(body) {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    throw new Error(`Query must contain ${MIN_QUERY_LENGTH} to ${MAX_QUERY_LENGTH} characters.`);
  }
  return query;
}

// A record may be chosen from the picker or named inside the request sentence.
// Either way the attributes come from the registry, never from the prose.
function resolveRecord(body, query) {
  if (typeof body.recordId === 'string' && body.recordId.length > 0) {
    const selected = findResource(body.recordId);
    if (!selected) throw new Error('Select a registered resource.');
    return selected;
  }
  const named = resolveRecordFromQuery(query);
  if (named) return named;
  throw new Error(`Name a registered record in your request, for example ${recordIdentifiers().join(', ')}.`);
}

function validateRequest(body, profile) {
  if (!profile) throw new Error('Sign in to submit a request.');
  const query = validateQuery(body);
  return {
    query,
    profile,
    record: resolveRecord(body, query),
    requestContext: {
      emergencyFlag: body.emergencyFlag === true,
      approvalTokenPresent: body.approvalTokenPresent === true,
    },
  };
}

function publicContext(profile) {
  return {
    profile,
    resources,
    policy: { policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION, orderedRules: ORDERED_RULES },
  };
}

function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(PUBLIC_ROOT, `.${requested}`);
  if (!filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) return json(res, 404, { error: 'Not found.' });
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_error) {
    return json(res, 404, { error: 'Not found.' });
  }
  if (!stat.isFile()) return json(res, 404, { error: 'Not found.' });
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'",
  });
  return fs.createReadStream(filePath).pipe(res);
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
  const profile = findProfile(typeof body.profileId === 'string' ? body.profileId.trim() : '');
  if (!profile) return json(res, 401, { error: 'That officer identifier is not registered.' });
  const session = createSession(profile.id);
  return json(res, 200, { profile }, { 'Set-Cookie': sessionCookie(session.token) });
}

function handleLogout(req, res) {
  destroySession(parseCookies(req.headers?.cookie)[SESSION_COOKIE]);
  return json(res, 200, { signedOut: true }, { 'Set-Cookie': clearedCookie() });
}

async function handleDecide(req, res, profile) {
  try {
    const request = validateRequest(await readBody(req), profile);
    const output = await decide({
      query: request.query,
      profileId: request.profile.id,
      subject: modelSubject(request.profile),
      record: request.record,
      requestContext: request.requestContext,
    });
    return json(res, 200, {
      requestId: crypto.randomUUID(),
      decidedAtUtc: new Date().toISOString(),
      profile: request.profile,
      resource: request.record,
      ...output,
    });
  } catch (error) {
    const clientError = /Select|Query|Name a registered|body|Sign in/.test(error.message);
    return json(res, clientError ? 400 : 503, {
      error: error.message,
      safetyDecision: 'escalate',
      explanation: clientError
        ? 'The request needs valid registered context before the model can decide.'
        : 'The system could not obtain a validated model decision, so it did not allow access.',
    });
  }
}

async function handler(req, res) {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

  if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, await checkModel());
  if (req.method === 'GET' && pathname === '/api/directory') {
    return json(res, 200, { profiles: directory(), recordIds: recordIdentifiers() });
  }
  if (req.method === 'POST' && pathname === '/api/login') return handleLogin(req, res);
  if (req.method === 'POST' && pathname === '/api/logout') return handleLogout(req, res);

  if (req.method === 'GET' && pathname === '/api/session') {
    const authenticated = requireSession(req, res);
    return authenticated ? json(res, 200, { profile: authenticated.profile }) : undefined;
  }
  if (req.method === 'GET' && pathname === '/api/context') {
    const authenticated = requireSession(req, res);
    return authenticated ? json(res, 200, publicContext(authenticated.profile)) : undefined;
  }
  if (req.method === 'POST' && pathname === '/api/decide') {
    const authenticated = requireSession(req, res);
    return authenticated ? handleDecide(req, res, authenticated.profile) : undefined;
  }

  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(pathname, res);
  return json(res, 405, { error: 'Method not allowed.' });
}

if (require.main === module) {
  http.createServer((req, res) => {
    handler(req, res).catch((error) => json(res, 500, { error: error.message }));
  }).listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`LLMxAI interface: http://127.0.0.1:${PORT}\n`);
  });
}

module.exports = { handler, publicContext, resolveRecord, validateRequest };
