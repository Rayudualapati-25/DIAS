/**
 * DIAS auditor console.
 *
 * Every request that no active dynamic authorization settled arrives here after
 * the model has recorded an advisory recommendation — or recorded that it could
 * produce none. The AuditMSP reviewer sees all verified facts, the untrusted
 * justification as submitted, and the model's answer clearly marked as advisory,
 * and is the only actor who can decide.
 *
 * Two things this screen must never do: present the model's answer as an
 * outcome, and let an auditor create a dynamic authorization without knowing it.
 */

import { api } from '../core/api.js';
import { DYNAMIC_POLICY_AUDITOR_ROLES } from '../core/access.js';
import {
  card, grid, table, button, mono, hint, subheading, asyncRegion, attempt,
  detailTable, badge, textarea, callout,
} from '../core/components.js';
import { el, slot, replace } from '../core/dom.js';
import { count, dateTime, shortHash } from '../core/format.js';
import {
  reviewSummary, recommendationView, authorizationView,
  willCreateAuthorization, requiresOverrideReason, authorizationOutcomeNote,
} from '../shared/dias.js';
import { auditorRequestFromSearch } from '../shared/auditor-handoff.js';

const show = (input) => (input === undefined || input === null || input === '' ? '—' : String(input));

const yesNo = (flag) => badge(flag ? 'yes' : 'no', flag ? 'allow' : 'neutral');

/** Colour a recommendation pill without ever implying it decided anything. */
function recommendationBadge(view) {
  if (!view.available) return badge(view.label, 'warn');
  return badge(view.recommendation, view.recommendation === 'ALLOW' ? 'allow' : 'deny');
}

function verifiedFactsTable(item) {
  return detailTable([
    ['Username (stable id)', el('div', {}, mono(show(item.username)),
      el('small', { class: 'block' }, show(item.stableUserId)))],
    ['Organization / MSP', `${show(item.organization)} · ${show(item.mspId)}`],
    ['Role / rank', `${show(item.role)} · ${show(item.rank)}`],
    ['Station / jurisdiction', `${show(item.station)} · ${show(item.jurisdiction)}`],
    ['Clearance', show(item.clearance)],
    ['Credential status', badge(show(item.credentialStatus),
      item.credentialStatus === 'active' ? 'allow' : 'deny')],
    ['Assigned to requested case', yesNo(item.assignedToRequestedCase)],
  ]);
}

function resourceTable(item) {
  return detailTable([
    ['Record / case', `${show(item.recordId)} · ${show(item.caseId)}`],
    ['Record type / sensitivity', `${show(item.recordType)} · ${show(item.sensitivity)}`],
    ['Record jurisdiction', show(item.recordJurisdiction)],
    ['Owner', `${show(item.owningAgency)} · ${show(item.owningStation)}`],
    ['Sealed', yesNo(item.sealed)],
    ['Juvenile', yesNo(item.juvenileFlag)],
    ['Witness', yesNo(item.witnessFlag)],
    ['Victim protection', yesNo(item.victimProtectionFlag)],
  ]);
}

function requestTable(item) {
  return detailTable([
    ['Action', show(item.action)],
    ['Purpose', show(item.purpose)],
    ['Emergency flag asserted', yesNo(item.emergencyFlag)],
    ['Submitted', dateTime(item.submittedAtUtc)],
  ]);
}

/** The model's answer, or a plain statement that there is none. */
function recommendationCard(item) {
  const view = item.recommendation;
  if (!view.available) {
    return el('div', {},
      el('div', { class: 'llm-verdict warn' },
        el('div', { class: 'llm-verdict-label' }, 'No model recommendation'),
        el('div', { class: 'llm-verdict-value' }, view.status),
        hint(view.errorCode ? `Generation failed: ${view.errorCode}. ` : '',
          'The model produced nothing for this request. You still decide, and an '
          + 'override reason is required.')));
  }
  return el('div', {},
    el('div', { class: `llm-verdict ${view.recommendation.toLowerCase()}` },
      el('div', { class: 'llm-verdict-label' }, 'Model recommendation (advisory only)'),
      el('div', { class: 'llm-verdict-value' }, view.recommendation),
      hint('Reason code ', mono(show(view.reasonCode)),
        ' · this recommendation cannot grant or deny access.')),
    detailTable([
      ['Explanation', show(item.llmReason)],
      ['Explanation hash verified', badge(item.llmReasonHashVerified ? 'yes' : 'no',
        item.llmReasonHashVerified ? 'allow' : 'deny')],
      ['Policy references', view.policyRefs.length > 0
        ? el('div', {}, ...view.policyRefs.map((ref) => badge(ref, 'neutral'))) : '—'],
      ['Missing evidence', view.missingEvidence.length > 0
        ? el('ul', {}, ...view.missingEvidence.map((text) => el('li', {}, text))) : 'none'],
      ['Review flags', view.reviewFlags.length > 0
        ? el('div', {}, ...view.reviewFlags.map((flag) => badge(flag, 'warn'))) : 'none'],
    ]));
}

export default {
  id: 'auditor-review',
  title: 'Auditor review',
  group: 'Review',
  order: 10,
  allow: { roles: DYNAMIC_POLICY_AUDITOR_ROLES },
  summary: 'Final DIAS decisions and dynamic authorizations under AuditMSP authority.',

  mount() {
    const dialog = el('dialog', { class: 'auditor-dialog', 'aria-label': 'Auditor decision' });
    const dialogBody = slot();
    dialog.append(dialogBody);
    const authorizationDetail = slot();
    let queueRegion;

    const closeDialog = () => { if (dialog.open) dialog.close(); };

    const authorizationsRegion = asyncRegion({
      load: () => api.access.dynamicAuthorizations('all'),
      render: (records) => {
        if (records.length === 0) {
          return hint('No dynamic authorizations exist. One is created only when the model '
            + 'recommends DENY and an auditor records FORCE ALLOW.');
        }
        const showHistory = async (view) => {
          const history = await attempt(
            () => api.access.dynamicAuthorizationHistory(view.authorizationId));
          if (!history) return;
          replace(authorizationDetail,
            card(`Authorization history — ${show(view.authorizationId)}`,
              'Every version comes from Fabric key history, with its lifecycle events.',
              table(['Transaction', 'Status', 'State version'],
                history.history.map((entry) => [
                  mono(shortHash(entry.txId, 14)),
                  entry.value
                    ? badge(entry.value.status, entry.value.status === 'active' ? 'allow' : 'deny')
                    : 'deleted',
                  entry.value?.stateVersion ?? '—',
                ])),
              subheading('Lifecycle events'),
              table(['Event', 'Transaction', 'When'], history.events.map((event) => [
                event.eventType, mono(shortHash(event.txId, 14)), dateTime(event.timestamp),
              ]))));
        };
        const revoke = async (view) => {
          const reason = window.prompt(
            'Reason for revoking this dynamic authorization (required, recorded on the ledger):');
          if (!reason || reason.trim().length === 0) return;
          const result = await attempt(
            () => api.access.revokeDynamicAuthorization(view.authorizationId, reason.trim()),
            'Dynamic authorization revoked');
          if (result) {
            authorizationsRegion.reload();
            replace(authorizationDetail);
          }
        };
        return table(
          ['Authorization', 'Requester', 'Exact scope', 'Origin', 'Expires', 'Status', ''],
          records.map(authorizationView).map((view) => [
            el('div', {}, mono(show(view.authorizationId)),
              el('small', { class: 'block' }, `generation ${show(view.generation)} · v${show(view.stateVersion)}`)),
            mono(show(view.stableUserId), { truncate: true }),
            el('div', {}, `${show(view.recordId)} · ${show(view.caseId)}`,
              el('small', { class: 'block' }, `${show(view.action)} · ${show(view.purpose)}`)),
            view.originValid
              ? badge(view.origin, 'warn') : badge(view.origin, 'deny'),
            view.validUntilUtc ? dateTime(view.validUntilUtc) : 'no expiry',
            badge(show(view.status), view.active ? 'allow' : 'deny'),
            el('div', { class: 'actions tight' },
              button('Inspect', { kind: 'ghost', small: true, onclick: () => showHistory(view) }),
              view.active && button('Revoke', {
                kind: 'danger', small: true, onclick: () => revoke(view),
              })),
          ]),
          { emptyMessage: 'No dynamic authorizations.' });
      },
    });

    const showReview = async (requestId) => {
      const review = await attempt(() => api.access.auditorReview(requestId));
      if (!review) return;
      const item = reviewSummary(review);
      const reason = textarea('auditorReason', {
        maxlength: '500',
        rows: '3',
        placeholder: 'Reason for your decision',
        'aria-label': 'Auditor reason',
      });
      const consequence = slot({ class: 'auditor-consequence' });
      const problem = slot({ class: 'auditor-problem', role: 'alert' });

      /**
       * Both consequences, always visible.
       *
       * An earlier version revealed this on hover, which was wrong twice over:
       * `button()` forwards only `onclick`, so the handler never ran, and a
       * consequence an auditor has to discover is a consequence they can miss.
       * Showing both is what lets the choice be made with its effect known.
       */
      const renderConsequences = () => {
        replace(consequence, ...['FORCE_ALLOW', 'FORCE_DENY'].map((decision) => {
          const creates = willCreateAuthorization(review.recommendation, decision);
          return callout(creates ? 'warn' : 'info',
            `${decision.replace('_', ' ')} — ${creates
              ? 'creates a dynamic authorization' : 'no dynamic authorization'}`,
            hint(authorizationOutcomeNote(review.recommendation, decision)),
            hint(requiresOverrideReason(review.recommendation, decision)
              ? 'A reason is REQUIRED for this combination.'
              : 'A reason is optional here.'));
        }));
      };
      renderConsequences();

      const finalize = async (decision) => {
        replace(problem);
        if (requiresOverrideReason(review.recommendation, decision)
            && reason.value.trim().length === 0) {
          replace(problem, callout('bad', 'A reason is required',
            hint(`${decision.replace('_', ' ')} here differs from the model, or no `
              + 'recommendation exists. Record why before deciding — the chaincode '
              + 'requires it and the reason is committed to the ledger.')));
          reason.focus();
          return;
        }
        const result = await attempt(
          () => api.access.auditorDecision(requestId, decision, reason.value.trim()),
          decision === 'FORCE_ALLOW' ? 'Request force-allowed' : 'Request force-denied');
        if (!result) return;
        const outcome = result.accessOutcome || {};
        replace(dialogBody,
          el('div', { class: 'auditor-dialog-head' },
            el('h2', {}, 'Final decision recorded'),
            button('Close', { kind: 'ghost', small: true, onclick: closeDialog })),
          el('div', { class: `llm-verdict ${outcome.outcome === 'GRANTED' ? 'allow' : 'deny'}` },
            el('div', { class: 'llm-verdict-label' }, 'Auditor final decision — authoritative'),
            el('div', { class: 'llm-verdict-value' }, show(result.auditorDecision?.decision)),
            hint('Access outcome ', mono(show(outcome.outcomeId)),
              ' · basis ', mono(show(outcome.basis)))),
          result.dynamicAuthorization
            ? callout('good', 'Dynamic authorization created',
              hint('The model recommended DENY and you recorded FORCE ALLOW. Authorization ',
                mono(show(result.dynamicAuthorization.authorizationId)),
                ' now grants exactly this user, record, case, action and purpose automatically '
                + 'while the governed conditions are unchanged.'))
            : callout('info', 'No dynamic authorization created',
              hint(authorizationOutcomeNote(review.recommendation, decision))));
        queueRegion.reload();
        authorizationsRegion.reload();
      };

      replace(dialogBody,
        el('div', { class: 'auditor-dialog-head' },
          el('div', {},
            el('h2', {}, `Review ${show(item.recordId)}`),
            hint('Request ', mono(show(item.requestId)), ' · ', dateTime(item.submittedAtUtc))),
          button('Close', { kind: 'ghost', small: true, onclick: closeDialog })),
        recommendationCard(item),
        subheading('Verified requester facts'),
        verifiedFactsTable(item),
        subheading('Requested record'),
        resourceTable(item),
        subheading('Requested action and purpose'),
        requestTable(item),
        subheading('User justification (untrusted)'),
        callout('info', 'Written by the requester',
          el('p', { class: 'justification' }, show(item.justification)),
          hint('Hash verified against the ledger: ',
            badge(item.justificationHashVerified ? 'yes' : 'no',
              item.justificationHashVerified ? 'allow' : 'deny'),
            ' · Claims here are not verified facts.')),
        el('label', { class: 'field' },
          el('span', { class: 'field-label' }, 'Auditor reason'), reason),
        problem,
        consequence,
        callout('warn', 'Your decision is final',
          hint('The model recommendation above is advisory. Only this decision, or an '
            + 'already-active dynamic authorization, determines access.')),
        el('div', { class: 'actions auditor-actions' },
          button('Force Allow', { onclick: () => finalize('FORCE_ALLOW') }),
          button('Force Deny', { kind: 'danger', onclick: () => finalize('FORCE_DENY') })));

      if (!dialog.open) dialog.showModal();
    };

    queueRegion = asyncRegion({
      load: () => api.access.auditorPending(),
      render: (pending) => {
        if (pending.length === 0) return hint('No requests are waiting for an auditor.');
        return el('div', {},
          hint(count(pending.length, 'request'), ' waiting for a final decision.'),
          table(
            ['Record', 'Username', 'Role', 'Action · purpose', 'Model says', 'Submitted', ''],
            pending.map((review) => {
              const item = reviewSummary(review);
              return [
                mono(show(item.recordId), { truncate: true }),
                mono(show(item.username)),
                show(item.role),
                `${show(item.action)} · ${show(item.purpose)}`,
                recommendationBadge(item.recommendation),
                dateTime(item.submittedAtUtc),
                button('Review', { small: true, onclick: () => showReview(item.requestId) }),
              ];
            })));
      },
    });

    const layout = grid(
      card('Pending auditor decisions',
        'The model has recommended, or recorded that it could not. Only an AuditMSP '
        + 'district authority can make the final decision.',
        el('div', { class: 'actions' },
          button('Refresh', { kind: 'ghost', onclick: () => queueRegion.reload() })),
        queueRegion),
      card('Dynamic authorizations',
        'Latest committed Fabric state. An active exact-scope authorization grants '
        + 'automatically, skipping both the model and the auditor.',
        el('div', { class: 'actions' },
          button('Refresh', { kind: 'ghost', onclick: () => authorizationsRegion.reload() })),
        authorizationsRegion,
        authorizationDetail),
      dialog);
    layout.classList.add('single-column');
    const linkedRequestId = auditorRequestFromSearch();
    if (linkedRequestId) {
      // Consume the one-shot handoff parameter. Otherwise navigating away and
      // back to this module would reopen an already-reviewed request.
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);
      window.setTimeout(() => showReview(linkedRequestId), 0);
    }
    return layout;
  },
};
