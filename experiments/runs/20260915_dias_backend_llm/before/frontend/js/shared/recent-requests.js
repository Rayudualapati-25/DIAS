/**
 * A requester's own recent access requests, remembered per browser session so
 * they can return to a pending escalation after navigating away.
 *
 * The ledger stays the source of truth: entries hold only identifiers and the
 * last status seen, and are re-read with api.access.decision when reopened.
 */

const KEY_PREFIX = 'crn.recent-requests.';
const MAX_ENTRIES = 10;

const storageKey = (username) => `${KEY_PREFIX}${username}`;

export function loadRecentRequests(username) {
  try {
    const raw = sessionStorage.getItem(storageKey(username));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Returns the new list, most recent first. The stored list is never mutated. */
export function rememberRequest(username, decision) {
  const entry = {
    recordId: decision.recordId,
    requestId: decision.requestId || decision.decisionId,
    decisionId: decision.decisionId || null,
    decision: decision.decision || null,
    status: decision.status,
    createdAtUtc: decision.createdAtUtc || decision.submittedAtUtc,
  };
  const others = loadRecentRequests(username)
    .filter((item) => (item.requestId || item.decisionId) !== entry.requestId);
  const next = [entry, ...others].slice(0, MAX_ENTRIES);
  try {
    sessionStorage.setItem(storageKey(username), JSON.stringify(next));
  } catch {
    // Storage can be unavailable (private mode); the returned list still renders.
  }
  return next;
}
