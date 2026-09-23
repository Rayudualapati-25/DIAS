/**
 * The decision log, read from the ledger by anyone signed in.
 *
 * Every settled request appears here: who asked for which case file, what was
 * decided, who decided it, and whether that decision agreed with the LLM. It is
 * deliberately open to every organization on the channel — a decision that only
 * its maker can see is not an accountable decision. The justification, the LLM
 * recommendation and the auditor's reason are not here: they are off-chain, and
 * only a reviewer sees them, through the audit trail.
 */

import { api } from '../core/api.js';
import {
  card, grid, table, button, badge, mono, hint, asyncRegion, el,
} from '../core/components.js';
import { dateTime, shortHash } from '../core/format.js';
import { agreementLabel } from '../shared/dias.js';

const show = (value) => (value === undefined || value === null || value === '' ? '—' : String(value));

function decidedBy(entry) {
  if (entry.basis === 'DYNAMIC_AUTHORIZATION') {
    return el('div', {}, badge('dynamic authorization', 'neutral'),
      el('small', { class: 'block' }, show(entry.authorizationId)));
  }
  return el('div', {}, mono(show(entry.auditor && entry.auditor.username)),
    el('small', { class: 'block' }, show(entry.auditor && entry.auditor.role)));
}

function agreementCell(entry) {
  if (!entry.llmAgreement) return hint('LLM not consulted');
  return el('div', {}, mono(entry.llmAgreement),
    el('small', { class: 'block' }, agreementLabel(entry.llmAgreement)));
}

export default {
  id: 'decision-log',
  title: 'Decision log',
  group: 'Access',
  order: 20,
  allow: undefined,
  summary: 'Every decision on the ledger: who asked for what, and what was decided.',

  mount() {
    const region = asyncRegion({
      load: () => api.access.decisionLog(100),
      loadingMessage: 'Reading the decision log from Fabric…',
      render: ({ entries }) => {
        if (entries.length === 0) {
          return hint('No request has been decided yet on this channel.');
        }
        return el('div', {},
          hint(`${entries.length} decision${entries.length === 1 ? '' : 's'} on the ledger, newest first.`),
          table(
            ['When', 'Requester', 'Case file', 'Action · purpose', 'Outcome', 'Decided by',
              'Agreement with the LLM', 'Transaction'],
            entries.map((entry) => [
              dateTime(entry.decidedAtUtc),
              el('div', {}, mono(show(entry.requester.username)),
                el('small', { class: 'block' }, `${show(entry.requester.role)} · ${show(entry.requester.organization)}`)),
              el('div', {}, mono(show(entry.recordId)),
                el('small', { class: 'block' }, show(entry.caseId))),
              `${show(entry.action)} · ${show(entry.purpose)}`,
              badge(show(entry.outcome), entry.outcome === 'GRANTED' ? 'allow' : 'deny'),
              decidedBy(entry),
              agreementCell(entry),
              mono(shortHash(entry.decisionTxId || entry.outcomeTxId, 16)),
            ])));
      },
    });

    return grid(card('Decisions recorded on the blockchain',
      'Committed by the chaincode: the request (who asked for which case file, with the action '
      + 'and purpose) and the decision (the auditor, their FORCE ALLOW or FORCE DENY, and whether '
      + 'it agreed with the LLM). Every organization on the channel reads the same list.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
      region));
  },
};
