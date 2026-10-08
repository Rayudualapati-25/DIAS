/** Turn the safe, structured Fabric access-event target into a compact label. */
export function accessTargetSummary(target) {
  if (!target || typeof target !== 'object') return '—';
  const parts = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null && value !== '') parts.push(`${label} ${value}`);
  };
  add('record', target.recordId);
  add('request', target.requestId);
  add('decision', target.decisionId);
  add('authorization', target.authorizationId);
  add('case', target.caseId);
  add('action', target.action);
  add('purpose', target.purpose);
  if (target.filters && typeof target.filters === 'object') {
    const filters = Object.entries(target.filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    if (filters) parts.push(`search ${filters}`);
  }
  return parts.join(' · ') || '—';
}

// ---------------------------------------------------------------------------
// The access-request log
// ---------------------------------------------------------------------------

/** Order of the time column. */
export const SORT = Object.freeze({ NEWEST: 'newest', OLDEST: 'oldest' });

/** No filter set: every row is shown. */
export const NO_FILTERS = Object.freeze({ text: '', llm: '', decision: '' });

const present = (value) => value !== undefined && value !== null && value !== '';
const joined = (...parts) => parts.filter(present).join(' · ') || null;

/** What the LLM recommended for this request, or why there is nothing to show. */
function llmCell(entry) {
  const recommended = entry.llmRecommendation;
  if (recommended === 'ALLOW' || recommended === 'DENY') {
    return { value: recommended, label: recommended, detail: null };
  }
  if (recommended === 'UNAVAILABLE') {
    return { value: 'NONE', label: 'No recommendation', detail: 'the model produced none' };
  }
  if (entry.basis === 'DYNAMIC_AUTHORIZATION') {
    return { value: 'NOT_ASKED', label: 'Not asked', detail: 'a reusable authorization matched' };
  }
  return { value: 'NOT_RECORDED', label: 'Not recorded', detail: 'the request ended without a decision' };
}

/** How the auditor's decision stands against the LLM recommendation. */
function agreementText(entry) {
  if (entry.llmAgreement === 'AGREED') return `agreed with the LLM's ${entry.llmRecommendation}`;
  if (entry.llmAgreement === 'NOT_AGREED') return `against the LLM's ${entry.llmRecommendation}`;
  return 'decided without an LLM recommendation';
}

/** What the auditor decided, always stated together with the LLM recommendation. */
function decisionCell(entry) {
  if (entry.decision === 'FORCE_ALLOW' || entry.decision === 'FORCE_DENY') {
    const auditor = entry.auditor && entry.auditor.username;
    return {
      value: entry.decision,
      label: entry.decision.replace('_', ' '),
      detail: joined(agreementText(entry), present(auditor) ? `by ${auditor}` : null),
    };
  }
  if (entry.basis === 'DYNAMIC_AUTHORIZATION') {
    return {
      value: 'NONE',
      label: 'Not needed',
      detail: present(entry.authorizationId)
        ? `granted by reusable authorization ${entry.authorizationId}`
        : 'granted by a reusable authorization',
    };
  }
  if (entry.outcome === 'CANCELLED') {
    return { value: 'NONE', label: 'No decision', detail: 'cancelled by the requester' };
  }
  if (entry.outcome === 'EXPIRED') {
    return { value: 'NONE', label: 'No decision', detail: 'the request expired' };
  }
  return { value: 'NONE', label: 'No decision', detail: null };
}

/**
 * One row of the access log, from an entry of the ledger's decision log: who
 * requested, what was requested, what the LLM recommended, and what the auditor
 * decided — stated together with the recommendation it was taken against.
 */
export function accessRequestRow(entry) {
  const requester = entry?.requester || {};
  return {
    requestId: entry?.requestId ?? null,
    time: entry?.decidedAtUtc ?? null,
    who: {
      name: present(requester.username) ? requester.username : '—',
      detail: joined(requester.role, requester.organization),
    },
    what: {
      name: present(entry?.recordId) ? entry.recordId : '—',
      detail: joined(entry?.action, entry?.purpose),
    },
    llm: llmCell(entry || {}),
    decision: decisionCell(entry || {}),
  };
}

/** The rows ordered by time, as a new list. */
export function sortAccessRows(rows, order = SORT.NEWEST) {
  const direction = order === SORT.OLDEST ? 1 : -1;
  return [...rows].sort((left, right) => direction * String(left.time).localeCompare(String(right.time)));
}

/** The rows that match every filter that is set. */
export function filterAccessRows(rows, filters = NO_FILTERS) {
  const text = String(filters.text || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.llm && row.llm.value !== filters.llm) return false;
    if (filters.decision && row.decision.value !== filters.decision) return false;
    if (!text) return true;
    return [row.who.name, row.what.name, row.requestId]
      .some((value) => String(value ?? '').toLowerCase().includes(text));
  });
}

/** How many filters are set, for the number on the filter button. */
export function activeFilterCount(filters = NO_FILTERS) {
  return [String(filters.text || '').trim(), filters.llm, filters.decision].filter(present).length;
}
