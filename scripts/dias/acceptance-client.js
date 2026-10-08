'use strict';

/**
 * HTTP client and result helpers for the live DIAS acceptance run.
 *
 * Every call goes through the application backend exactly as the web interface
 * does, so the run exercises the real path: backend LLM call, off-chain review
 * store, and chaincode request and decision logs.
 */

const POLL_MS = 1000;
const RECOMMENDATION_TIMEOUT_MS = 600000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(baseUrl) {
  const tokens = new Map();

  async function api(method, route, { username, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (username) headers.Authorization = `Bearer ${await token(username)}`;
    const response = await fetch(`${baseUrl}${route}`, {
      method, signal: AbortSignal.timeout(180000),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, data: json.data, error: json.error };
  }

  async function token(username) {
    if (!tokens.has(username)) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        signal: AbortSignal.timeout(30000), method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(`login failed for ${username}: ${json.error}`);
      tokens.set(username, json.data.token);
    }
    return tokens.get(username);
  }

  const submit = (username, spec) => api('POST', '/access/request', { username, body: spec });
  const request = (username, requestId) => api('GET', `/access/request/${requestId}`, { username });
  const review = (requestId, auditor = 'sp.north') => api('GET', `/access/auditor/${requestId}`, { username: auditor });
  const trail = (requestId, username = 'sp.north') => api('GET', `/audit/request-trail/${requestId}`, { username });
  const decide = (requestId, body, auditor = 'sp.north') =>
    api('POST', `/access/auditor/${requestId}/decision`, { username: auditor, body });

  /** Wait until the backend has finished preparing the LLM recommendation. */
  async function readyReview(requestId, { timeoutMs = RECOMMENDATION_TIMEOUT_MS, auditor = 'sp.north' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // The status route reads encrypted storage through the backend, without
      // opening a review or appending one audit transaction per poll.
      const prepared = await api('GET', `/access/auditor/pending/status?ids=${encodeURIComponent(requestId)}`, { username: auditor });
      if (prepared.status !== 200 || !Array.isArray(prepared.data) || !prepared.data[0]) {
        throw new Error(`preparation status ${requestId}: ${prepared.status} ${prepared.error}`);
      }
      if (prepared.data[0].preparing) {
        if (Date.now() >= deadline) throw new Error(`no recommendation for ${requestId} within ${timeoutMs} ms`);
        await sleep(POLL_MS);
        continue;
      }
      const result = await review(requestId, auditor);
      // The request is committed through the requester's peer and read through
      // the auditor's peer.  Immediately after commit, the latter can briefly
      // return the chaincode's 422 "does not exist" until it receives the block.
      // Treat only that convergence window as retryable; every other HTTP error
      // is still terminal and visible to the run.
      const converging = result.status === 422
        && /does not exist/i.test(String(result.error || ''));
      if (result.status !== 200 && !converging) {
        throw new Error(`review ${requestId} failed: ${result.status} ${result.error}`);
      }
      if (converging) {
        if (Date.now() > deadline) {
          throw new Error(`request ${requestId} was not visible to the auditor within ${timeoutMs} ms`);
        }
        await sleep(POLL_MS);
        continue;
      }
      if (['committed', 'failed', 'commit-rejected', 'not-generated'].includes(result.data.recommendationState)) return result.data;
      if (Date.now() > deadline) throw new Error(`no recommendation for ${requestId} within ${timeoutMs} ms`);
      await sleep(POLL_MS);
    }
  }

  return { api, token, submit, request, review, trail, decide, readyReview };
}

const check = (name, ok, detail) => ({ name, ok: Boolean(ok), detail: String(detail) });

function scenario(id, title, checks, evidence = {}) {
  const failed = checks.filter((item) => !item.ok);
  return { id, title, status: failed.length === 0 ? 'PASS' : 'FAIL', checks, evidence };
}

function notExercised(id, title, why, evidence = {}) {
  return { id, title, status: 'NOT EXERCISED', checks: [check('scenario prerequisites', false, why)], evidence };
}

/** Lifecycle event types of a trail, in order. */
const stagesOf = (trail) => (trail.lifecycle || []).map((event) => event.eventType);

/** The ledger part of a trail, without the backend's off-chain section. */
function ledgerOnly(trail) {
  // Both sections are added by the backend after it reads committed state.
  // Verification describes checks on the off-chain payload, not ledger fields.
  const { offChainReview, offChainVerification, ...ledger } = trail;
  return ledger;
}

module.exports = {
  check, createClient, ledgerOnly, notExercised, scenario, sleep, stagesOf,
};
