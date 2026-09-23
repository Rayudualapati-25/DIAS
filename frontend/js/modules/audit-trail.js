/**
 * Audit trail of one record.
 *
 * The ledger holds two logs for every DIAS request: who requested which record
 * (with the action and purpose), and the auditor decision with whether it agreed
 * with the LLM. This screen reconstructs both from Fabric, lists the access
 * grants and the record's own state history, and — for reviewers — shows the
 * off-chain review the backend kept (justification, LLM recommendation, auditor
 * reason), clearly marked as not being on the ledger.
 */

import { api } from '../core/api.js';
import { ALLOW } from '../core/access.js';
import {
  card, grid, field, input, form, table, button, badge, mono, hint, subheading,
  slot, replace, el, detailTable, callout,
} from '../core/components.js';
import { dateTime, shortHash } from '../core/format.js';
import { agreementLabel } from '../shared/dias.js';

const show = (value) => (value === undefined || value === null || value === '' ? '—' : String(value));
const statusTone = (status) => (status === 'granted' ? 'allow' : status === 'denied' ? 'deny' : 'pending');

/** The off-chain review, which never came from the ledger. */
function offChainReviewBlock(review, request) {
  if (!review) {
    return hint(request.processingPath === 'dynamic-authorization'
      ? 'No off-chain review exists for this request: an active dynamic authorization '
        + 'granted it without the LLM or an auditor.'
      : 'This backend holds no off-chain review for this request. The ledger still records '
        + 'the request and any auditor decision with its LLM agreement.');
  }
  const rec = review.recommendation || {};
  return callout('info', 'Off-chain review — kept in the backend, not on the ledger',
    detailTable([
      ['Justification (untrusted)', show(review.justification)],
      ['LLM recommendation', review.recommendationState === 'pending'
        ? 'being prepared'
        : rec.generationStatus === 'OK'
          ? badge(rec.recommendation, rec.recommendation === 'ALLOW' ? 'allow' : 'deny')
          : `none (${show(rec.generationStatus)})`],
      ['Reason code', mono(show(rec.reasonCode))],
      ['LLM explanation', show(rec.reason)],
      ['Auditor reason', show(review.auditorNote && review.auditorNote.reason)],
    ]));
}

function requestTrailCard(trail) {
  const request = trail.request || {};
  const decision = trail.auditorDecision;
  return card(`Request ${show(trail.requestId)}`,
    'Reconstructed from Fabric world state and key history.',
    subheading('Request log'),
    detailTable([
      ['Requester', el('div', {}, mono(show(request.requester && request.requester.username)),
        el('small', { class: 'block' }, show(request.requester && request.requester.stableUserId)))],
      ['Record / case', `${show(request.recordId)} · ${show(request.caseId)}`],
      ['Action / purpose', `${show(request.action)} · ${show(request.purpose)}`],
      ['Submitted', dateTime(request.submittedAtUtc)],
      ['Transaction', mono(shortHash(request.txId, 20))],
    ]),
    subheading('Decision log'),
    decision
      ? detailTable([
        ['Auditor', mono(show(decision.auditor && decision.auditor.username))],
        ['Decision', badge(show(decision.decision), decision.decision === 'FORCE_ALLOW' ? 'allow' : 'deny')],
        ['Agreement with the LLM', el('div', {}, mono(show(decision.llmAgreement)),
          el('small', { class: 'block' }, agreementLabel(decision.llmAgreement)))],
        ['Dynamic authorization created', show(decision.createdAuthorizationId || 'no')],
        ['Decided', dateTime(decision.decidedAtUtc)],
        ['Transaction', mono(shortHash(decision.txId, 20))],
      ])
      : hint(request.auditorReviewStatus === 'SKIPPED'
        ? 'No auditor decision: an active dynamic authorization granted this request.'
        : 'No auditor decision yet.'),
    subheading('Ledger lifecycle'),
    table(['#', 'Stage', 'Transaction', 'When'], (trail.lifecycle || []).map((event) => [
      String(event.seq), event.eventType, mono(shortHash(event.txId, 14)), dateTime(event.timestamp),
    ])),
    trail.viewer === 'reviewer'
      ? [subheading('Off-chain review'), offChainReviewBlock(trail.offChainReview, request)] : []);
}

export default {
  id: 'audit-trail',
  title: 'Audit trail',
  group: 'Audit',
  order: 10,
  allow: ALLOW.REVIEWER,
  summary: 'Who requested each record, and every auditor decision with its LLM agreement.',

  mount() {
    const output = slot();
    const detail = slot();

    const body = form({
      submitLabel: 'Reconstruct trail',
      fields: [field('Record ID', input('recordId', {
        placeholder: 'REC-FIR-001', required: true,
      }))],
      onSubmit: async (values) => {
        const recordId = values.recordId.trim();
        const trail = await api.audit.trail(recordId);
        replace(detail);
        const openRequest = async (requestId) => {
          replace(detail, requestTrailCard(await api.audit.requestTrail(requestId)));
        };
        const requests = [...(trail.requests || [])]
          .sort((a, b) => String(a.submittedAtUtc).localeCompare(String(b.submittedAtUtc)));
        const decisions = [...(trail.accessDecisions || [])]
          .sort((a, b) => String(a.createdAtUtc).localeCompare(String(b.createdAtUtc)));
        replace(output,
          subheading('Access requests'),
          table(['Submitted', 'Requester', 'Action · purpose', 'Path', 'Status', ''],
            requests.map((item) => [
              dateTime(item.submittedAtUtc),
              mono(show(item.requester)),
              `${show(item.action)} · ${show(item.purpose)}`,
              show(item.processingPath),
              badge(show(item.status), statusTone(item.status)),
              button('Lifecycle', { kind: 'ghost', small: true, onclick: () => openRequest(item.requestId) }),
            ]),
            { emptyMessage: 'No access requests recorded for this record.' }),
          detail,
          subheading('Access outcomes'),
          table(['When', 'Requester', 'Action', 'Outcome', 'Decided by'], decisions.map((item) => [
            dateTime(item.createdAtUtc),
            mono(show(item.subject && item.subject.username)),
            show(item.action),
            badge(show(item.status), statusTone(item.status)),
            show(item.decisionAuthority),
          ]), { emptyMessage: 'No access outcomes recorded for this record.' }),
          subheading('Record state history'),
          table(['#', 'Transaction', 'Seal state', 'When'], (trail.recordHistory || []).map((entry, index) => [
            String(index + 1),
            mono(shortHash(entry.txId)),
            entry.value ? (entry.value.sealed ? badge('sealed', 'deny') : badge('open', 'allow')) : '—',
            entry.value ? dateTime(entry.value.sealChangedAtUtc || entry.value.createdAtUtc) : '—',
          ])));
      },
    });

    return grid(card('Audit trail reconstruction',
      'Access requests, auditor decisions with their LLM agreement, access outcomes, and record history from the ledger.',
      body, output));
  },
};
