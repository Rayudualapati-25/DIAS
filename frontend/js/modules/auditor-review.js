/**
 * DIAS auditor console.
 *
 * Every request that no active dynamic authorization settled arrives here. The
 * backend asks the LLM at once for an advisory recommendation and its signed
 * commitment κ is written to the ledger before review; this screen shows the
 * recommendation — or that it is still being prepared, or that none could be
 * produced — and recomputes its digest against κ in the browser. While one is
 * being prepared the screen checks by itself and shows it when ready. The AuditMSP
 * reviewer sees all verified facts, the untrusted justification as submitted,
 * and the model's answer clearly marked as advisory, and is the only actor who
 * can decide. The ledger records the decision and its agreement with κ; the
 * recommendation object itself stays off-chain.
 *
 * Two things this screen must never do: present the model's answer as an
 * outcome, and let an auditor create a dynamic authorization without knowing it.
 */

import { api } from '../core/api.js';
import { ALLOW } from '../core/access.js';
import {
  card, grid, table, button, mono, hint, subheading, asyncRegion, attempt,
  detailTable, badge, textarea, callout,
} from '../core/components.js';
import { el, slot, replace } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { count, dateTime, shortHash } from '../core/format.js';
import {
  reviewSummary, authorizationView, agreementLabel, decisionAvailability, llmAgreement,
  willCreateAuthorization, requiresOverrideReason, authorizationOutcomeNote,
  recommendationIntegrity, committedRecommendation, justificationCommitmentView, decisionFailureView,
  isRecommendationPreparing,
} from '../shared/dias.js';
import { auditorRequestFromSearch } from '../shared/auditor-handoff.js';
import { createRecommendationWatch, preparingRequestIds } from '../shared/recommendation-watch.js';
import { counterfactualPanel } from '../shared/counterfactual-panel.js';

const show = (input) => (input === undefined || input === null || input === '' ? '—' : String(input));

/** The two final decisions, disabled with the reason when this auditor may not decide. */
function decisionButtons(finalize, availability) {
  const allow = button('Force Allow', { onclick: () => finalize('FORCE_ALLOW') });
  const deny = button('Force Deny', { kind: 'danger', onclick: () => finalize('FORCE_DENY') });
  if (!availability.allowed) {
    for (const control of [allow, deny]) {
      control.disabled = true;
      control.title = availability.message;
    }
  }
  return [allow, deny];
}

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
    ['Emergency declared (requester claim, not verified)',
      item.emergencyDeclared === null ? '—' : yesNo(item.emergencyDeclared)],
    ['Submitted', dateTime(item.submittedAtUtc)],
  ]);
}

/**
 * Whether the recommendation shown is the one committed on the ledger before
 * review. Recomputed in this browser (recommendationIntegrity), not taken from
 * the backend.
 */
function integrityCallout(review) {
  const integrity = recommendationIntegrity(review);
  const commitment = review.commitment || {};
  if (integrity.status === 'verified') {
    return callout('good', 'Checked against the ledger',
      hint('This is the recommendation committed before review: commitment ', mono(show(commitment.commitmentId)),
        ' · h_M ', mono(shortHash(commitment.recommendationHash, 16)),
        ' · signed by key ', mono(shortHash(commitment.signerKeyId, 12)), '.'));
  }
  if (integrity.status === 'no-commitment') {
    return callout('info', 'No recommendation was committed on the ledger',
      hint('The decision will be recorded as NO_RECOMMENDATION, and a reason is required.'));
  }
  return callout('bad', 'This recommendation does not match the ledger',
    ...integrity.problems.map((problem) => hint(problem)),
    hint('No decision can be recorded until the committed recommendation object is restored.'));
}

/** Whether the justification shown is the text whose fingerprint (h_J) the ledger holds. */
function justificationFingerprint(text, request) {
  if (typeof text !== 'string') {
    return hint('The text is not available here; the ledger holds only its fingerprint.');
  }
  const commitment = justificationCommitmentView(text, request);
  if (commitment.status === 'match') {
    return hint('Off-chain text; its fingerprint on the ledger, ', mono(shortHash(commitment.committed, 16)),
      ', matches what is shown.');
  }
  if (commitment.status === 'mismatch') {
    return hint('Warning: this text does not match the fingerprint committed on the ledger.');
  }
  return hint('Off-chain text; this request carries no fingerprint on the ledger.');
}

/** The model's answer, or a plain statement that there is none yet or at all. */
function recommendationCard(item, { onRefresh }) {
  const view = item.recommendation;
  if (view.pending) {
    return el('div', {},
      el('div', { class: 'llm-verdict warn' },
        el('div', { class: 'llm-verdict-label' }, 'Model recommendation'),
        el('div', { class: 'llm-verdict-value' }, 'Being prepared'),
        hint('The backend is asking the LLM about this request. This screen checks every few '
          + 'seconds and shows the recommendation as soon as it is ready; you can decide once '
          + 'it, or its failure, is ready.')),
      el('div', { class: 'actions' },
        button('Refresh recommendation', { kind: 'ghost', small: true, onclick: onRefresh })));
  }
  if (!view.available) {
    return el('div', {},
      el('div', { class: 'llm-verdict warn' },
        el('div', { class: 'llm-verdict-label' }, 'No model recommendation'),
        el('div', { class: 'llm-verdict-value' }, view.status),
        hint(view.errorCode ? `Generation failed: ${view.errorCode}. ` : '',
          'The model produced nothing for this request. You still decide, a reason is '
          + 'required, and the ledger records that no recommendation existed.')));
  }
  return el('div', {},
    el('div', { class: `llm-verdict ${view.recommendation.toLowerCase()}` },
      el('div', { class: 'llm-verdict-label' }, 'Model recommendation (advisory only)'),
      el('div', { class: 'llm-verdict-value' }, view.recommendation),
      hint('Reason code ', mono(show(view.reasonCode)),
        ' · this recommendation cannot grant or deny access.')),
    detailTable([
      ['Explanation', show(item.llmReason)],
      ['Stored', 'off-chain; its digest h_M was committed on the ledger before review'],
      ['Policy references', view.policyRefs.length > 0
        ? el('div', {}, ...view.policyRefs.map((ref) => badge(ref, 'neutral'))) : '—'],
      ['Missing evidence', view.missingEvidence.length > 0
        ? el('ul', {}, ...view.missingEvidence.map((text) => el('li', {}, text))) : 'none'],
      ['Review flags', view.reviewFlags.length > 0
        ? el('div', {}, ...view.reviewFlags.map((flag) => badge(flag, 'warn'))) : 'none'],
    ]));
}

/** What the auditor has typed so far and where the caret is, to carry it over a refresh. */
function draftOf(reason) {
  return {
    text: reason.value,
    focused: document.activeElement === reason,
    start: reason.selectionStart,
    end: reason.selectionEnd,
  };
}

const WATCH_STOPPED_NOTICE = 'Automatic checking has stopped. Press Refresh to check again.';

export default {
  id: 'auditor-review',
  title: 'Auditor review',
  group: 'Review',
  order: 10,
  allow: ALLOW.AUDITOR,
  summary: 'Final DIAS decisions and dynamic authorizations under AuditMSP authority.',

  mount({ user }) {
    const dialog = el('dialog', { class: 'auditor-dialog', 'aria-label': 'Auditor decision' });
    const dialogBody = slot();
    dialog.append(dialogBody);
    const authorizationDetail = slot();
    let queueRegion;
    let layout;
    // What the screen is waiting for: the queue's unfinished recommendations, and
    // the open review's when it is one of them.
    let waitingInQueue = [];
    let openedReview = null;
    // Counts every opening and refresh of a review, so that an answer which arrives
    // after a newer one, or after the dialog was closed, is dropped.
    let reviewSequence = 0;
    // Shown in the queue card and in an open review when automatic checking gave up.
    const queueNotice = slot();
    const reviewNotice = slot();
    const setWatchNotice = (text) => [queueNotice, reviewNotice]
      .forEach((node) => replace(node, text ? hint(text) : null));

    const closeDialog = () => { if (dialog.open) dialog.close(); };

    const watch = createRecommendationWatch({
      check: (requestIds) => api.access.auditorPendingStatus(requestIds),
      isActive: () => Boolean(layout && layout.isConnected),
      onReady: (readyIds) => {
        if (readyIds.some((requestId) => waitingInQueue.includes(requestId))) {
          queueRegion.reload({ quiet: true });
        }
        if (dialog.open && openedReview && readyIds.includes(openedReview.requestId)) {
          showReview(openedReview.requestId, { automatic: true });
        }
      },
      onStopped: () => setWatchNotice(WATCH_STOPPED_NOTICE),
    });
    const syncWatch = () => {
      setWatchNotice(null);
      watch.watch([
        ...waitingInQueue,
        ...(dialog.open && openedReview && openedReview.preparing ? [openedReview.requestId] : []),
      ]);
    };
    dialog.addEventListener('close', () => {
      openedReview = null;
      reviewSequence += 1;
      syncWatch();
    });

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

    /**
     * Open or refresh the review of one request. `keepDraft` carries over what the
     * auditor typed when the dialog already shows this request. `automatic` marks a
     * refresh the screen started itself: it never reopens a dialog the auditor
     * closed and never replaces a review the auditor has since switched to.
     */
    const showReview = async (requestId, { keepDraft = false, automatic = false } = {}) => {
      reviewSequence += 1;
      const mine = reviewSequence;
      const [review, explanation] = await Promise.all([
        attempt(() => api.access.auditorReview(requestId)),
        api.access.requestRecommendation(requestId).catch(() => null),
      ]);
      if (!review || mine !== reviewSequence) return;
      const showingThis = dialog.open && openedReview !== null && openedReview.requestId === requestId;
      if (automatic && !showingThis) return;
      // Read after the answer arrived, so nothing typed while waiting is lost.
      const draft = (keepDraft || automatic) && showingThis ? draftOf(openedReview.reason) : null;
      const item = reviewSummary(review);
      const availability = decisionAvailability(review, user.username);
      // Consequences follow the recommendation committed on the ledger (κ).
      const committed = committedRecommendation(review);
      const reason = textarea('auditorReason', {
        maxlength: '2000',
        rows: '3',
        placeholder: 'Reason for your decision',
        'aria-label': 'Auditor reason',
      });
      if (draft) reason.value = draft.text;
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
          const creates = willCreateAuthorization(committed, decision);
          return callout(creates ? 'warn' : 'info',
            `${decision.replace('_', ' ')} — ${creates
              ? 'creates a dynamic authorization' : 'no dynamic authorization'}`,
            hint(authorizationOutcomeNote(committed, decision)),
            hint('The ledger will record: ', agreementLabel(llmAgreement(committed, decision)), '.'),
            hint(requiresOverrideReason(committed, decision)
              ? 'A reason is REQUIRED for this combination.'
              : 'A reason is optional here.'));
        }));
      };
      renderConsequences();

      const finalize = async (decision) => {
        replace(problem);
        if (!availability.allowed) {
          replace(problem, callout('bad', 'This request cannot be decided here',
            hint(availability.message),
            availability.reason === 'own-request'
              ? hint('Sign in to this window as another district head of the record\'s district '
                + '— for example dj.north, cfo.north or dp.north — and open the request again.')
              : hint('It appears here by itself when it is ready; the button above checks now.')));
          return;
        }
        if (requiresOverrideReason(committed, decision)
            && reason.value.trim().length === 0) {
          replace(problem, callout('bad', 'A reason is required',
            hint(`${decision.replace('_', ' ')} here differs from the model, or no `
              + 'recommendation exists. Record why before deciding. The note is saved off-chain '
              + 'first, and only its fingerprint is written to the ledger with the decision.')));
          reason.focus();
          return;
        }
        // The error is shown in the dialog, not only as a toast that disappears:
        // a refusal from the chaincode is the answer to what the auditor just did.
        let result;
        try {
          result = await api.access.auditorDecision(requestId, decision, reason.value.trim());
        } catch (error) {
          const failure = decisionFailureView({ status: error.status, message: error.message });
          replace(problem, callout(failure.tone, failure.title, ...failure.lines.map((line) => hint(line))));
          if (failure.tone !== 'bad') queueRegion.reload();
          return;
        }
        toast(decision === 'FORCE_ALLOW' ? 'Request force-allowed' : 'Request force-denied', 'success');
        openedReview = null;
        const outcome = result.accessOutcome || {};
        replace(dialogBody,
          el('div', { class: 'auditor-dialog-head' },
            el('h2', {}, 'Final decision recorded'),
            button('Close', { kind: 'ghost', small: true, onclick: closeDialog })),
          el('div', { class: `llm-verdict ${outcome.outcome === 'GRANTED' ? 'allow' : 'deny'}` },
            el('div', { class: 'llm-verdict-label' }, 'Auditor final decision — authoritative'),
            el('div', { class: 'llm-verdict-value' }, show(result.auditorDecision?.decision)),
            hint('Access outcome ', mono(show(outcome.outcomeId)),
              ' · basis ', mono(show(outcome.basis))),
            hint('Recorded on the ledger: ', agreementLabel(result.auditorDecision?.llmAgreement),
              ' (', mono(show(result.auditorDecision?.llmAgreement)), ').')),
          result.dynamicAuthorization
            ? callout('good', 'Dynamic authorization created',
              hint('The model recommended DENY and you recorded FORCE ALLOW. Authorization ',
                mono(show(result.dynamicAuthorization.authorizationId)),
                ' now grants exactly this user, record, case, action and purpose automatically '
                + 'while the governed conditions are unchanged.'))
            : callout('info', 'No dynamic authorization created',
              hint(authorizationOutcomeNote(committed, decision))));
        queueRegion.reload();
        authorizationsRegion.reload();
      };

      replace(dialogBody,
        el('div', { class: 'auditor-dialog-head' },
          el('div', {},
            el('h2', {}, `Review ${show(item.recordId)}`),
            hint('Request ', mono(show(item.requestId)), ' · ', dateTime(item.submittedAtUtc))),
          button('Close', { kind: 'ghost', small: true, onclick: closeDialog })),
        availability.allowed ? null : callout('warn',
          availability.reason === 'own-request'
            ? 'You cannot decide your own request'
            : 'This request cannot be decided yet',
          hint(availability.message),
          availability.reason === 'own-request'
            ? hint('Sign in to this window as another district head of the record\'s district '
              + '— dj.north, cfo.north or dp.north — and open the request again.')
            : null,
          // The recommendation card has its own button while nothing is shown yet.
          availability.reason === 'recommendation-pending' && !item.recommendation.pending
            ? el('div', { class: 'actions' }, button('Check again', {
              kind: 'ghost', small: true, onclick: () => showReview(requestId, { keepDraft: true }),
            }))
            : null),
        recommendationCard(item, {
          onRefresh: () => showReview(requestId, { keepDraft: true }),
        }),
        counterfactualPanel(explanation),
        reviewNotice,
        integrityCallout(review),
        subheading('Verified requester facts'),
        verifiedFactsTable(item),
        subheading('Requested record'),
        resourceTable(item),
        subheading('Requested action and purpose'),
        requestTable(item),
        subheading('User justification (untrusted)'),
        callout('info', 'Written by the requester',
          el('p', { class: 'justification' }, show(item.justification)),
          justificationFingerprint(item.justification, review.request),
          hint('Claims here are not verified facts.')),
        el('label', { class: 'field' },
          el('span', { class: 'field-label' }, 'Auditor reason'), reason),
        problem,
        consequence,
        callout('warn', 'Your decision is final',
          hint('The model recommendation above is advisory. Only this decision, or an '
            + 'already-active dynamic authorization, determines access.')),
        el('div', { class: 'actions auditor-actions' }, ...decisionButtons(finalize, availability)));

      if (!dialog.open) dialog.showModal();
      if (draft && draft.focused) {
        reason.focus();
        reason.setSelectionRange(draft.start, draft.end);
      }
      openedReview = { requestId, reason, preparing: isRecommendationPreparing(review) };
      syncWatch();
    };

    queueRegion = asyncRegion({
      load: () => api.access.auditorPending(),
      render: (pending) => {
        waitingInQueue = preparingRequestIds(pending);
        syncWatch();
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

    layout = grid(
      card('Pending auditor decisions',
        'Each request shows the LLM recommendation the backend prepared, or that it is '
        + 'still being prepared or could not be. A recommendation that is being prepared '
        + 'appears here by itself when it is ready. Only an AuditMSP district authority can '
        + 'make the final decision.',
        el('div', { class: 'actions' },
          button('Refresh', { kind: 'ghost', onclick: () => queueRegion.reload() })),
        queueNotice,
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
