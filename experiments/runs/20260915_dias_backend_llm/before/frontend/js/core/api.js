/**
 * API client and session.
 *
 * Adding an endpoint: put it in the matching group below. Groups mirror the
 * backend routers (auth / records / access / audit / explain), so the two stay
 * easy to compare.
 *
 * Every call returns the unwrapped `data` or throws an Error carrying the
 * server's message — callers never see the {success, data, error} envelope.
 */

const BASE = '/api';
const TOKEN_KEY = 'crn.token';
const USER_KEY = 'crn.user';

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const session = {
  token: () => sessionStorage.getItem(TOKEN_KEY),
  user: () => {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save: (token, user) => {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear: () => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  },
};

/** Notified when the server rejects our token, so the shell can show login. */
let onSessionExpired = () => {};
export function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function request(method, path, body) {
  const token = session.token();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('cannot reach the server — is the backend running?');
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`server returned ${res.status} with no JSON body`);
  }

  if (res.status === 401 && token) {
    session.clear();
    onSessionExpired();
    throw new Error('your session expired — please sign in again');
  }
  if (!json.success) throw new Error(json.error || `request failed (${res.status})`);
  return json.data;
}

async function requestBlob(path) {
  const token = session.token();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new Error('cannot reach the server — is the backend running?');
  }
  if (res.status === 401 && token) {
    session.clear();
    onSessionExpired();
    throw new Error('your session expired — please sign in again');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `request failed (${res.status})`);
  }
  return res.blob();
}

const query = (params) => {
  const usable = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== '');
  return usable.length ? `?${new URLSearchParams(usable).toString()}` : '';
};

// ---------------------------------------------------------------------------
// Endpoints, grouped to match the backend routers
// ---------------------------------------------------------------------------

export const api = {
  auth: {
    async login(username) {
      const data = await request('POST', '/auth/login', { username });
      session.save(data.token, data.user);
      return data.user;
    },
    me: () => request('GET', '/auth/me'),
  },

  // Accounts live on the ledger, not in a database. `register` performs both
  // halves in one call: a Fabric CA enrolment, then a CreateUser transaction.
  users: {
    list: () => request('GET', '/users'),
    get: (username) => request('GET', `/users/${username}`),
    history: (username) => request('GET', `/users/${username}/history`),
    register: (body) => request('POST', '/users', body),
    setStatus: (username, status) =>
      request('POST', `/users/${username}/status`, { status }),
  },

  departments: {
    list: () => request('GET', '/departments'),
    create: (body) => request('POST', '/departments', body),
  },

  cases: {
    list: () => request('GET', '/cases'),
    get: (caseId) => request('GET', `/cases/${caseId}`),
    create: (body) => request('POST', '/cases', body),
    assign: (caseId, userId) => request('POST', `/cases/${caseId}/assign`, { userId }),
    workflow: (caseId) => request('GET', `/cases/${caseId}/workflow`),
    advance: (caseId, body) => request('POST', `/cases/${caseId}/workflow`, body),
  },

  records: {
    create: (payload) => request('POST', '/records', payload),
    search: (filters) => request('GET', `/records${query(filters)}`),
    lookup: (recordId) => request('GET', `/records/lookup/${recordId}`),
    get: (recordId) => request('GET', `/records/${recordId}`),
    payload: (recordId) => request('GET', `/records/${recordId}/payload`),
    metadata: (recordId, decisionId) =>
      request('GET', `/records/${recordId}/metadata/${decisionId}`),
    requestDocument: (recordId, decisionId) =>
      request('POST', `/records/${recordId}/document-requests`, { decisionId }),
    documentRequests: () => request('GET', '/records/document-requests/mine'),
    uploadDocument: (requestId, body) =>
      request('POST', `/records/document-requests/${requestId}/upload`, body),
    documentContent: (requestId) =>
      requestBlob(`/records/document-requests/${requestId}/content`),
    seal: (recordId) => request('POST', `/records/${recordId}/seal`),
    unseal: (recordId) => request('POST', `/records/${recordId}/unseal`),
  },

  evidence: {
    list: (recordId) => request('GET', `/records/${recordId}/evidence`),
    attach: (recordId, body) => request('POST', `/records/${recordId}/evidence`, body),
    detail: (recordId, evidenceId) =>
      request('GET', `/records/${recordId}/evidence/${evidenceId}/detail`),
    custody: (recordId, evidenceId) =>
      request('GET', `/records/${recordId}/evidence/${evidenceId}/custody`),
    transfer: (recordId, evidenceId, body) =>
      request('POST', `/records/${recordId}/evidence/${evidenceId}/custody`, body),
  },

  access: {
    // One request endpoint. The response says whether an active dynamic
    // authorization settled it outright or whether an auditor must decide.
    request: (body) => request('POST', '/access/request', body),
    accessRequest: (requestId) => request('GET', `/access/request/${requestId}`),
    requestTrail: (requestId) => request('GET', `/access/request/${requestId}/trail`),
    forRecord: (recordId) => request('GET', `/access/record/${recordId}`),
    decision: (recordId, decisionId) =>
      request('GET', `/access/decision/${recordId}/${decisionId}`),
    auditorPending: () => request('GET', '/access/auditor/pending'),
    auditorReview: (requestId) => request('GET', `/access/auditor/${requestId}`),
    // FORCE_ALLOW / FORCE_DENY. `reason` is mandatory whenever the auditor
    // differs from the recommendation or none exists; the chaincode enforces it.
    auditorDecision: (requestId, decision, reason, validUntilUtc) =>
      request('POST', `/access/auditor/${requestId}/decision`,
        validUntilUtc ? { decision, reason, validUntilUtc } : { decision, reason }),
    dynamicAuthorizations: (status = 'active') =>
      request('GET', `/access/dynamic-authorizations${query({ status })}`),
    dynamicAuthorization: (authorizationId) =>
      request('GET', `/access/dynamic-authorizations/${authorizationId}`),
    dynamicAuthorizationHistory: (authorizationId) =>
      request('GET', `/access/dynamic-authorizations/${authorizationId}/history`),
    revokeDynamicAuthorization: (authorizationId, reason) =>
      request('POST', `/access/dynamic-authorizations/${authorizationId}/revoke`, { reason }),
  },

  audit: {
    trail: (recordId) => request('GET', `/audit/trail/${recordId}`),
    requestTrail: (requestId) => request('GET', `/audit/request-trail/${requestId}`),
    verifyPayload: (recordId) => request('POST', `/audit/verify-payload/${recordId}`),
    verifyRecommendationReason: (requestId, reason) =>
      request('POST', `/audit/verify-recommendation-reason/${requestId}`, { reason }),
    accessLog: (limit = 50) => request('GET', `/audit/access-log${query({ limit })}`),
    verifyAccessLog: () => request('GET', '/audit/access-log/verify'),
  },

  explain: {
    decision: (recordId, decisionId) => request('POST', `/explain/${recordId}/${decisionId}`),
    health: () => request('GET', '/explain/health'),
  },
};
