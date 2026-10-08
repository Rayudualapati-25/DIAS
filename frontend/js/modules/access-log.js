/**
 * The access log.
 *
 * "Access requests" is the log itself. For every settled request on the ledger
 * it shows who requested which case file, what the LLM recommended, and what the
 * auditor decided — stated together with the recommendation it was taken
 * against. It is read from the ledger's decision records; nothing is written for
 * it, and none of the LLM's text is shown.
 *
 * "Searches and reads" keeps the application access events: who searched, who
 * read a record, who received a case file. Those are submitted directly as
 * Fabric transactions; there is no external access-log database.
 */

import { api } from '../core/api.js';
import { ALLOW } from '../core/access.js';
import {
  card, grid, table, button, badge, mono, hint, callout, slot, replace,
  asyncRegion, attempt, el, tabs, iconButton, field, input, select,
} from '../core/components.js';
import { dateTime, actor, count, timestamp } from '../core/format.js';
import { actionLabel, outcomeKind } from '../shared/vocab.js';
import {
  NO_FILTERS, SORT, accessRequestRow, accessTargetSummary, activeFilterCount,
  filterAccessRows, sortAccessRows,
} from '../shared/access-log.js';

/** How many settled requests and access events one load reads from the ledger. */
const ACCESS_REQUEST_LIMIT = 100;
const ACCESS_EVENT_LIMIT = 60;

const LLM_FILTERS = Object.freeze([
  { value: '', label: 'Any' },
  { value: 'ALLOW', label: 'ALLOW' },
  { value: 'DENY', label: 'DENY' },
  { value: 'NONE', label: 'No recommendation' },
  { value: 'NOT_ASKED', label: 'Not asked' },
]);
const DECISION_FILTERS = Object.freeze([
  { value: '', label: 'Any' },
  { value: 'FORCE_ALLOW', label: 'FORCE ALLOW' },
  { value: 'FORCE_DENY', label: 'FORCE DENY' },
  { value: 'NONE', label: 'No auditor decision' },
]);

/** A cell with a main line and, when there is one, a quieter second line. */
function cell(main, detail, { status = false } = {}) {
  return el('div', {},
    el('span', { class: status ? 'cell-main status' : 'cell-main' }, main),
    detail ? el('small', { class: 'cell-detail' }, detail) : null);
}

/** What the line under the title says about the list that is shown. */
function refreshedNote({ shown, total, refreshedAt }) {
  if (!refreshedAt) return 'Reading the ledger…';
  return [
    `Last refreshed ${refreshedAt.toLocaleTimeString()}.`,
    shown < total ? `Showing ${shown} of ${total}.` : null,
    total >= ACCESS_REQUEST_LIMIT ? `Only the newest ${ACCESS_REQUEST_LIMIT} settled requests are loaded.` : null,
  ].filter(Boolean).join(' ');
}

/** The log's heading: title, count, last refresh, and the refresh and filter buttons. */
function requestsHead({ shown, total, refreshedAt, filtersOpen, filters, onRefresh, onToggleFilters }) {
  return el('div', { class: 'log-head' },
    el('div', {},
      el('h3', { class: 'log-title' }, 'Access requests',
        refreshedAt ? el('span', { class: 'count-pill' }, String(shown)) : null),
      el('p', { class: 'log-refreshed' }, refreshedNote({ shown, total, refreshedAt }))),
    el('div', { class: 'log-tools' },
      iconButton('refresh', { label: 'Refresh', onclick: onRefresh }),
      iconButton('filter', {
        label: filtersOpen ? 'Hide filters' : 'Show filters',
        pip: activeFilterCount(filters),
        pressed: filtersOpen,
        onclick: onToggleFilters,
      })));
}

/** The rows as a plain table whose time column sorts both ways. */
function requestsTable({ rows, anyLoaded, order, onToggleOrder }) {
  const oldestFirst = order === SORT.OLDEST;
  const sortButton = el('button', {
    class: 'sort-btn',
    type: 'button',
    title: oldestFirst ? 'Oldest first. Press for newest first.' : 'Newest first. Press for oldest first.',
    onclick: onToggleOrder,
  }, 'Time', el('span', { class: 'arrow', 'aria-hidden': 'true' }, oldestFirst ? '▲' : '▼'));
  const node = table(
    [sortButton, 'Who requested', 'What was requested', 'LLM recommended', 'Auditor decided'],
    rows.map((row) => [
      timestamp(row.time),
      cell(row.who.name, row.who.detail),
      cell(row.what.name, row.what.detail),
      cell(row.llm.label, row.llm.detail, { status: true }),
      cell(row.decision.label, row.decision.detail, { status: true }),
    ]),
    {
      emptyMessage: anyLoaded
        ? 'No entry matches the filters.'
        : 'No request has been settled yet on this channel.',
    });
  node.classList.add('log');
  return node;
}

/** The filter controls. `onChange` receives the filters whenever one of them changes. */
function filterControls(onChange) {
  const changed = () => onChange({ text: text.value, llm: llm.value, decision: decision.value });
  const text = input('logText', {
    type: 'search', placeholder: 'Requester, case file or request', oninput: changed,
  });
  const llm = select('logLlm', LLM_FILTERS, { onchange: changed });
  const decision = select('logDecision', DECISION_FILTERS, { onchange: changed });
  const clear = () => {
    text.value = '';
    llm.value = '';
    decision.value = '';
    changed();
  };
  const bar = el('div', { class: 'log-filters', hidden: true },
    field('Search', text),
    field('LLM recommended', llm),
    field('Auditor decided', decision),
    button('Clear', { kind: 'ghost', small: true, onclick: clear }));
  return { bar, focus: () => text.focus() };
}

/** Who requested, what, the LLM recommendation, and the auditor decision. */
function requestsPanel() {
  let state = {
    rows: [], order: SORT.NEWEST, filters: NO_FILTERS, filtersOpen: false, refreshedAt: null,
  };
  const head = slot();
  const list = slot({ class: 'region' });
  const controls = filterControls((filters) => update({ filters }));

  function renderHead(shown) {
    replace(head, requestsHead({
      ...state, shown, total: state.rows.length, onRefresh: load, onToggleFilters: toggleFilters,
    }));
  }

  function render() {
    const shown = sortAccessRows(filterAccessRows(state.rows, state.filters), state.order);
    controls.bar.hidden = !state.filtersOpen;
    renderHead(shown.length);
    replace(list, requestsTable({
      rows: shown,
      anyLoaded: state.rows.length > 0,
      order: state.order,
      onToggleOrder: () => update({ order: state.order === SORT.OLDEST ? SORT.NEWEST : SORT.OLDEST }),
    }));
  }

  function update(changes) {
    state = { ...state, ...changes };
    render();
  }

  function toggleFilters() {
    update({ filtersOpen: !state.filtersOpen });
    if (state.filtersOpen) controls.focus();
  }

  async function load() {
    replace(list, hint('Reading the access log from Fabric…'));
    try {
      const data = await api.access.decisionLog(ACCESS_REQUEST_LIMIT);
      update({ rows: (data.entries || []).map(accessRequestRow), refreshedAt: new Date() });
    } catch (error) {
      replace(list, callout('bad', 'Could not load this', hint(error.message)));
    }
  }

  renderHead(0);
  load();
  return el('div', {}, head, controls.bar, list);
}

/** The application access events: searches, reads and refused calls. */
function eventsPanel() {
  const verdict = slot();
  const region = asyncRegion({
    load: () => api.audit.accessLog(ACCESS_EVENT_LIMIT),
    render: (data) => el('div', {},
      hint(count(data.entries.length, 'entry', 'entries'),
        ' shown · stored directly on the Fabric ledger'),
      table(['Transaction', 'When', 'Who', 'Did what', 'Record / request', 'Outcome'],
        data.entries.map((entry) => [
          entry.txId ? entry.txId.slice(0, 10) : '—',
          dateTime(entry.timestamp),
          actor(entry.actorUsername, entry.actorRole),
          actionLabel(entry.action),
          mono(accessTargetSummary(entry.target)),
          badge(entry.outcome, outcomeKind(entry.outcome)),
        ]),
        { emptyMessage: 'The log is empty.' })),
  });

  const verify = async () => {
    const result = await attempt(() => api.audit.verifyAccessLog());
    if (!result) return;
    replace(verdict, callout(result.ok ? 'good' : 'bad',
      'Log integrity',
      hint('Result: ', badge(result.ok ? 'intact' : 'tampered', result.ok ? 'allow' : 'deny')),
      hint(`${result.entriesChecked} ledger event(s) returned. `
        + 'Integrity is provided by Fabric endorsement, ordering and block hashes.')));
  };

  return el('div', {},
    hint('Authenticated searches, reads and refused calls are recorded here as direct Fabric '
      + 'transactions. A new entry can take a few seconds to commit.'),
    el('div', { class: 'actions' },
      button('Refresh', { kind: 'ghost', onclick: () => region.reload() }),
      button('Describe integrity', { onclick: verify })),
    verdict, region);
}

export default {
  id: 'access-log',
  title: 'Access log',
  group: 'Audit',
  order: 30,
  allow: ALLOW.REVIEWER,
  summary: 'Who requested what, what the LLM recommended, and what the auditor decided.',

  mount() {
    // The page heading above already names the screen, so the card starts at the tabs.
    return grid(card(null, null,
      tabs([
        { id: 'requests', label: 'Access requests', render: requestsPanel },
        { id: 'events', label: 'Searches and reads', render: eventsPanel },
      ])));
  },
};
