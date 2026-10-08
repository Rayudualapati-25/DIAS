/**
 * The decision log, read from the ledger by anyone signed in.
 *
 * Every settled request appears here: what was decided, the LLM recommendation
 * that decision was taken against — or that none was available — and whether the
 * two agreed. That much is open to every organization on the channel: a decision
 * that only its maker can see is not an accountable decision. Who asked, for
 * which case file, who decided and in which transaction are shown to reviewers
 * only; everyone else receives the reduced entries (design §10). The LLM's own
 * account opens from here for district heads of the audit organisation; the
 * officer who made a request reads theirs on the request screen.
 */

import { api } from '../core/api.js';
import { ALLOW, canAccess } from '../core/access.js';
import {
  card, grid, table, button, badge, mono, hint, asyncRegion, el,
  subheading, detailTable, callout, slot, replace, attempt,
} from '../core/components.js';
import { dateTime, shortHash } from '../core/format.js';
import { agreementLabel, decisionLogRow, recommendationLabel } from '../shared/dias.js';
import { counterfactualPanel } from '../shared/counterfactual-panel.js';

const show = (value) => (value === undefined || value === null || value === '' ? '—' : String(value));
const showList = (values) => (values && values.length > 0 ? values.join(', ') : '—');

function decidedBy(entry) {
  if (entry.basis === 'DYNAMIC_AUTHORIZATION') {
    return el('div', {}, badge('dynamic authorization', 'neutral'),
      el('small', { class: 'block' }, show(entry.authorizationId)));
  }
  return el('div', {}, mono(show(entry.auditor && entry.auditor.username)),
    el('small', { class: 'block' }, show(entry.auditor && entry.auditor.role)));
}

/**
 * Why an entry names no LLM recommendation. A reused authorization never asks the
 * LLM. A request that expired or was cancelled may have had a recommendation, but
 * the ledger's list carries it only with a decision.
 */
const noRecommendationText = (entry) => (entry.basis === 'DYNAMIC_AUTHORIZATION'
  ? 'LLM not consulted' : 'Not recorded: no decision was made');

function recommendationCell(entry) {
  if (!entry.llmRecommendation) return hint(noRecommendationText(entry));
  if (entry.llmRecommendation === 'UNAVAILABLE') {
    return el('div', {}, badge('unavailable', 'neutral'),
      el('small', { class: 'block' }, recommendationLabel(entry.llmRecommendation)));
  }
  return el('div', {}, badge(entry.llmRecommendation, entry.llmRecommendation === 'ALLOW' ? 'allow' : 'deny'),
    el('small', { class: 'block' }, recommendationLabel(entry.llmRecommendation)));
}

function agreementCell(entry) {
  if (!entry.llmAgreement) return hint(noRecommendationText(entry));
  return el('div', {}, mono(entry.llmAgreement),
    el('small', { class: 'block' }, agreementLabel(entry.llmAgreement)));
}

/**
 * The model's own account of one recommendation.
 *
 * Everyone reads the structured part. The free text is case narrative, so the
 * backend returns it only to the officer who made the request and to auditors;
 * for anyone else `reasonVisible` is false and this says so rather than pretending
 * there was nothing to read. How the recommendation was produced — timings, token
 * counts, model identity, policy hashes — is deliberately not shown.
 */
function detailPanel(entry, detail) {
  const heading = subheading(`Why ${entry.requestId} was decided as it was`);
  if (detail.recommendationState === 'pending') {
    return el('div', {}, heading,
      hint('The LLM recommendation for this request is still being prepared.'), counterfactualPanel(detail));
  }
  if (!detail.available) {
    return el('div', {}, heading,
      callout('warn', 'There was no LLM recommendation for this decision',
        hint('The auditor decided without one. The ledger records this as UNAVAILABLE.'),
        detailTable([
          ['Generation status', mono(show(detail.unavailable && detail.unavailable.generationStatus))],
          ['Reported cause', mono(show(detail.unavailable && detail.unavailable.errorCode))],
        ])), counterfactualPanel(detail));
  }
  return el('div', {}, heading,
    detailTable([
      ['LLM recommendation',
        badge(detail.recommendation, detail.recommendation === 'ALLOW' ? 'allow' : 'deny')],
      ['Reason code', mono(show(detail.reasonCode))],
      ['Policy clauses cited', showList(detail.policyRefs)],
      ['Evidence the model said was missing', showList(detail.missingEvidence)],
      ['Review flags raised', showList(detail.reviewFlags)],
      ['Written reason', detail.reasonVisible
        ? show(detail.reason)
        : hint('Restricted. The model\'s written reason can quote case detail, so it is '
          + 'shown only to the officer who made this request and to auditors.')],
    ]), counterfactualPanel(detail));
}

/** The log as a caller outside the reviewer set receives it: no names, files or transactions. */
function reducedTable(entries) {
  return table(
    ['When', 'Requester organization', 'Action · purpose', 'Outcome', 'Decided by',
      'LLM recommendation', 'Agreement with the LLM'],
    entries.map((entry) => {
      const row = decisionLogRow(entry);
      return [
        dateTime(row.when),
        show(row.organization),
        show(row.operation),
        badge(show(row.outcome), row.outcome === 'GRANTED' ? 'allow' : 'deny'),
        show(row.decidedBy),
        recommendationCell(entry),
        agreementCell(entry),
      ];
    }));
}

export default {
  id: 'decision-log',
  title: 'Decision log',
  group: 'Access',
  order: 20,
  allow: undefined,
  summary: 'Every decision on the ledger: who asked for what, and what was decided.',

  mount({ user }) {
    // The LLM's account is for district heads of the audit organisation.
    const mayOpenDetail = canAccess(user, ALLOW.AUDITOR);
    const region = asyncRegion({
      load: () => api.access.decisionLog(100),
      loadingMessage: 'Reading the decision log from Fabric…',
      render: ({ entries }) => {
        if (entries.length === 0) {
          return hint('No request has been decided yet on this channel.');
        }
        const total = hint(`${entries.length} decision${entries.length === 1 ? '' : 's'} on the ledger, newest first.`);
        if (entries.some((entry) => entry.redacted === true)) {
          return el('div', {}, total,
            callout('info', 'You see the reduced log',
              hint('It shows what was decided and against which LLM recommendation, without names, '
                + 'case files or transactions. Reviewers see the full log. Your own requests, with '
                + 'their decisions, are on the "Request access" screen.')),
            reducedTable(entries));
        }
        const panel = slot({ class: 'region' });
        const openDetail = async (entry) => {
          replace(panel, hint(`Reading the LLM detail for ${entry.requestId}…`));
          const detail = await attempt(() => api.access.requestRecommendation(entry.requestId));
          replace(panel, detail
            ? detailPanel(entry, detail)
            : callout('bad', 'Could not read the LLM detail for this decision'));
        };
        return el('div', {},
          total,
          table(
            ['When', 'Requester', 'Case file', 'Action · purpose', 'Outcome', 'Decided by',
              'LLM recommendation', 'Agreement with the LLM', 'Transaction', 'Detail'],
            entries.map((entry) => [
              dateTime(entry.decidedAtUtc),
              el('div', {}, mono(show(entry.requester.username)),
                el('small', { class: 'block' }, `${show(entry.requester.role)} · ${show(entry.requester.organization)}`)),
              el('div', {}, mono(show(entry.recordId)),
                el('small', { class: 'block' }, show(entry.caseId))),
              `${show(entry.action)} · ${show(entry.purpose)}`,
              badge(show(entry.outcome), entry.outcome === 'GRANTED' ? 'allow' : 'deny'),
              decidedBy(entry),
              recommendationCell(entry),
              agreementCell(entry),
              mono(shortHash(entry.decisionTxId || entry.outcomeTxId, 16)),
              entry.llmRecommendation && mayOpenDetail
                ? button('Why', { kind: 'ghost', onclick: () => openDetail(entry) })
                : hint('—'),
            ])),
          panel);
      },
    });

    return grid(card('Decisions recorded on the blockchain',
      'Committed by the chaincode: the request and the decision (FORCE ALLOW or FORCE DENY, the LLM '
      + 'recommendation it was taken against, and whether the two agreed). A recommendation the '
      + 'backend could not produce is recorded as unavailable. Every organization on the channel '
      + 'can read what was decided; who asked, for which case file and who decided are shown to '
      + 'reviewers only.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
      region));
  },
};
