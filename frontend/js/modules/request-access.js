/** The requester's screen, from finding a case file to opening it. */

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import {
  card, grid, row, field, input, select, textarea, form, table, detailTable, button,
  badge, mono, hint, slot, replace, attempt, callout, asyncRegion, subheading,
} from '../core/components.js';
import { ORG_LABEL } from '../core/access.js';
import {
  ACTIONS, PURPOSES, OUTCOME_CONSEQUENCE, defaultPurpose, purposeLabel, requestActionLabel,
} from '../shared/vocab.js';
import { dateTime, shortHash } from '../core/format.js';
import { rememberRequest } from '../shared/recent-requests.js';
import { searchForAccess } from '../shared/search-access.js';
import {
  accessDecisionView, isSettled, justificationCommitmentView, progressLabel, requesterDecisionView,
} from '../shared/dias.js';
import {
  prepareAuditorHandoff, completeAuditorHandoff, closeAuditorHandoff, openAuditorReview,
} from '../shared/auditor-handoff.js';

const LIVE_DOCUMENT_STATUSES = Object.freeze(['requested', 'ready']);
const statusKind = (status) => (status === 'granted' ? 'allow' : status === 'denied' ? 'deny' : 'escalate');
const hasLiveDocumentRequest = (items, decisionId) => items.some((item) =>
  item.decisionId === decisionId && LIVE_DOCUMENT_STATUSES.includes(item.status));

function metadataView(record) {
  const flags = [
    record.juvenileFlag && 'juvenile',
    record.witnessFlag && 'witness',
    record.victimProtectionFlag && 'victim protected',
  ].filter(Boolean).join(', ') || 'none';
  return detailTable([
    ['Case file', mono(record.recordId)],
    ['Case', mono(record.caseId)],
    ['Type', record.recordType],
    ['Sensitivity', badge(record.sensitivityLevel, 'neutral')],
    ['Status', badge(record.status, record.status === 'active' ? 'allow' : 'neutral')],
    ['Sealed', record.sealed ? badge('yes', 'deny') : badge('no', 'allow')],
    ['Special flags', flags],
    ['Jurisdiction', record.jurisdiction],
    ['Owning station', record.owningStation],
    ['Owning organization', record.owningAgency],
    ['Filed', dateTime(record.createdAtUtc)],
    ['Content commitment', mono(shortHash(record.contentCommitment))],
  ]);
}

/** The committed decision: the outcome, who decided it, and the ledger identifiers. */
function decisionSummary(decision) {
  const view = accessDecisionView(decision);
  return el('div', { class: 'decision-detail' },
    detailTable([
      ['Outcome', badge(view.outcomeLabel, view.granted ? 'allow' : 'deny')],
      ['Decided by', view.authorityLabel],
      ['Action · purpose', `${view.action || '—'} · ${view.purpose || '—'}`],
      ['Access outcome', mono(shortHash(view.decisionId, 24))],
      ['Request', mono(shortHash(view.requestId, 24))],
      view.automatic
        ? ['Dynamic authorization', mono(view.authorizationId || '—')]
        : ['Auditor decision', mono(view.auditorDecisionId || '—')],
      ['Recorded', dateTime(view.recordedAtUtc)],
    ]),
    hint(OUTCOME_CONSEQUENCE[view.granted ? 'granted' : 'denied']));
}

const listed = (values, none) => (values.length > 0 ? values.join(', ') : none);

/** The auditor's decision and, when the request was denied, the LLM's explanation. */
function decisionExplanation(detail) {
  const view = requesterDecisionView(detail);
  if (!view.decided) return null;
  const explained = view.explanation;
  if (explained === null) return el('div', { class: 'decision-detail' }, detailTable(view.rows));
  if (!explained.available) {
    return el('div', { class: 'decision-detail' }, detailTable(view.rows),
      explained.cause === 'explanation-missing'
        ? callout('warn', 'The LLM explanation is not available',
          hint('The ledger records the recommendation above, but this backend no longer holds its explanation.'))
        : callout('warn', 'There was no LLM recommendation for this request',
          hint('The auditor decided without one.')));
  }
  return el('div', { class: 'decision-detail' }, detailTable(view.rows),
    callout('info', 'The LLM explanation (advisory only)',
      el('p', { class: 'justification' }, explained.reason || '—'),
      detailTable([
        ['Reason code', mono(explained.reasonCode || '—')],
        ['Policy clauses cited', listed(explained.policyRefs, '—')],
        ['What the LLM said was missing', listed(explained.missingEvidence, 'nothing')],
        ['Review flags', listed(explained.reviewFlags, 'none')],
      ]),
      hint('The auditor made the decision. This explanation comes from the LLM, which decided nothing.')));
}

export default {
  id: 'request-access',
  title: 'Request access',
  group: 'Access',
  order: 1,
  allow: undefined,
  summary: 'Find a case file and request access; a dynamic authorization or an auditor decides.',

  mount({ user }) {
    const found = slot({ 'aria-live': 'polite' });
    const outcome = slot({ 'aria-live': 'polite', 'aria-atomic': 'false' });
    const recent = slot();
    let documentItems = [];
    let selected = null;            // { recordId, caseId, owningStation }
    let activeRequestId = null;
    let auditorHandoff = null;
    let auditorHandoffWasOpened = false;

    // --- the request form -------------------------------------------------
    const actionInput = select('action', ACTIONS.map((value) => ({ value, label: requestActionLabel(value) })),
      { 'aria-label': 'Operation' });
    const purposeInput = select('purpose', PURPOSES.map((value) => ({ value, label: purposeLabel(value) })),
      { 'aria-label': 'Purpose' });
    const justificationInput = textarea('justification', {
      required: true, minlength: '3', maxlength: '2000', rows: '4',
      placeholder: 'Example: I am the investigating officer on this case and need to read the FIR.',
      'aria-label': 'Why you need it',
    });
    actionInput.value = 'view';
    purposeInput.value = defaultPurpose(user.role);

    const openPdf = async (requestId) => {
      const viewer = window.open('', '_blank');
      if (viewer) viewer.opener = null;
      const blob = await attempt(() => api.records.documentContent(requestId));
      if (!blob) {
        viewer?.close();
        return;
      }
      const url = URL.createObjectURL(blob);
      if (viewer) viewer.location.replace(url);
      else window.location.assign(url);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };

    const myDocuments = asyncRegion({
      load: () => api.records.documentRequests(),
      loadingMessage: 'Checking your PDF requests on Fabric…',
      render: (items) => {
        documentItems = items;
        const mine = items.filter((item) => item.viewerRelation === 'requester');
        if (mine.length === 0) return hint('You have not requested a complete PDF yet.');
        const requestTable = table(['Case file', 'Owning station', 'Status', 'Requested', ''],
          mine.map((item) => [
            mono(item.recordId),
            item.owningStation,
            badge(item.status, item.status === 'ready' ? 'allow' : 'pending'),
            dateTime(item.requestedAtUtc),
            item.status === 'ready'
              ? button('View PDF', { small: true, onclick: () => openPdf(item.requestId) })
              : hint('Waiting for the owning station to upload it'),
          ]));
        requestTable.classList.add('document-request-table');
        return requestTable;
      },
    });

    const renderRecent = (entries) => {
      replace(recent, table(['Case file', 'Status', 'Requested', ''],
        entries.map((entry) => [
          mono(entry.recordId),
          badge(entry.status, statusKind(entry.status)),
          dateTime(entry.submittedAtUtc || entry.createdAtUtc),
          button('Open', {
            small: true, kind: 'ghost',
            onclick: () => {
              activeRequestId = entry.requestId || entry.decisionId;
              return recheckProgress();
            },
          }),
        ]),
        { emptyMessage: 'No access requests recorded for this identity yet.' }));
    };

    const refreshRequests = async () => {
      const history = await attempt(() => api.access.myRequests(100));
      if (history) renderRecent(history.entries || []);
    };

    // --- what happened to the request -------------------------------------
    const requestDetail = async (decision, output) => {
      const request = await attempt(
        () => api.records.requestDocument(decision.recordId, decision.decisionId),
        'Request sent to the owning station');
      if (!request) return false;
      myDocuments.reload();
      replace(output, callout('good', 'Complete case file requested',
        hint(`${request.owningStation} has been asked to upload the PDF. `
          + 'It appears under "My complete-file requests" below once it is ready.')));
      return true;
    };

    const showDecision = async (decision) => {
      closeAuditorHandoff(auditorHandoff);
      auditorHandoff = null;
      auditorHandoffWasOpened = false;
      activeRequestId = decision.requestId || decision.decisionId;
      renderRecent(rememberRequest(user.username, decision));
      refreshRequests();
      const view = accessDecisionView(decision);
      // What this officer may read of the auditor's decision and the LLM's account.
      const detail = view.automatic || !view.requestId ? null
        : await attempt(() => api.access.requestRecommendation(view.requestId));
      const explanation = decisionExplanation(detail);

      if (!view.granted) {
        replace(outcome, card('Access denied',
          'The case file stays closed. An AuditMSP auditor made this decision, and the ledger '
          + 'holds it together with whether it agreed with the LLM.',
          decisionSummary(decision),
          explanation && subheading('The auditor decision and the LLM explanation'),
          explanation));
        return;
      }

      const record = view.releasesMetadata
        ? await attempt(() => api.records.metadata(decision.recordId, decision.decisionId))
        : null;
      const requestOutput = slot();
      const requestButton = button('Request the complete file', {
        kind: 'ghost',
        onclick: async () => {
          requestButton.disabled = true;
          const sent = await requestDetail(decision, requestOutput);
          if (sent) requestButton.textContent = 'Requested';
          else requestButton.disabled = false;
        },
      });
      requestButton.disabled = hasLiveDocumentRequest(documentItems, decision.decisionId);
      if (requestButton.disabled) requestButton.textContent = 'Requested';

      replace(outcome,
        card('Access granted',
          view.automatic
            ? 'An exact active dynamic authorization matched this request, so neither the LLM '
              + 'nor an auditor was consulted.'
            : 'An AuditMSP auditor granted this request. The decision is on the Fabric ledger.',
          decisionSummary(decision),
          explanation && subheading('The auditor decision'),
          explanation),
        record && card('Case-file metadata',
          'Released because this exact identity holds a granted view decision on the ledger.',
          metadataView(record),
          el('div', { class: 'actions' }, requestButton),
          requestOutput));
    };

    const showPending = (request) => {
      activeRequestId = request.requestId;
      renderRecent(rememberRequest(user.username, request));
      refreshRequests();
      const routedNow = completeAuditorHandoff(auditorHandoff, request.requestId);
      if (routedNow) {
        auditorHandoff = null;
        auditorHandoffWasOpened = true;
      }
      replace(outcome,
        card('Waiting for the auditor',
          request.message || 'The request is on the ledger. An AuditMSP auditor makes the final '
            + 'decision; the LLM recommendation is prepared in the backend and shown only to them.',
          callout('warn', progressLabel(request),
            hint('Nothing is granted or refused while the request waits.')),
          detailTable([
            ['Request', mono(shortHash(request.requestId, 24))],
            ['Ledger status', badge(request.status, 'pending')],
            ['Action · purpose', `${request.action} · ${request.purpose}`],
            ['Submitted', dateTime(request.submittedAtUtc)],
            ['Review deadline', request.reviewDeadlineUtc ? dateTime(request.reviewDeadlineUtc) : '—'],
          ]),
          callout('info', auditorHandoffWasOpened ? 'Auditor window opened' : 'Auditor window',
            hint('Sign in to the separate window as a district head of the authority '
              + 'organisation — and not as the identity that raised this request, which the '
              + 'chaincode refuses.')),
          el('div', { class: 'actions' },
            button('Check current status', { kind: 'ghost', onclick: () => recheckProgress() }),
            button('Open auditor decision window', {
              onclick: () => openAuditorReview(request.requestId),
            }),
            button('Cancel request', {
              kind: 'danger',
              onclick: async () => {
                const cancelled = await attempt(
                  () => api.access.cancelRequest(request.requestId), 'Request cancelled');
                if (cancelled) await showProgress(cancelled.request);
              },
            }))));
    };

    const showProgress = async (result) => {
      if (['cancelled', 'expired'].includes(result.status)) {
        closeAuditorHandoff(auditorHandoff);
        auditorHandoff = null;
        activeRequestId = result.requestId;
        refreshRequests();
        replace(outcome, card(result.status === 'cancelled' ? 'Request cancelled' : 'Request expired',
          'This request is closed. No access was granted; submit a new search to request access again.',
          detailTable([['Request', mono(result.requestId)], ['Status', progressLabel(result)]])));
        return;
      }
      if (result.decisionId && ['granted', 'denied'].includes(result.status)) {
        await showDecision(result);
        return;
      }
      if (isSettled(result) && result.outcomeId) {
        const decision = await attempt(() => api.access.decision(result.recordId, result.outcomeId));
        if (decision) await showDecision(decision);
        return;
      }
      showPending(result);
    };

    async function recheckProgress() {
      if (!activeRequestId) return;
      const request = await attempt(() => api.access.accessRequest(activeRequestId));
      if (!request) return;
      await showProgress(request);
    }

    // --- submitting -------------------------------------------------------
    const submitRequest = async ({ action, purpose, justification }) => {
      if (!selected) throw new Error('Find and select a case file first.');
      closeAuditorHandoff(auditorHandoff);
      auditorHandoff = prepareAuditorHandoff();
      auditorHandoffWasOpened = false;
      replace(outcome, callout('info', `DIAS is recording the request for ${selected.recordId}`,
        hint('1. The request and its verified facts are committed on Fabric.'),
        hint('2. The latest active dynamic authorization is checked in the same transaction.'),
        hint('3. On a miss, the backend asks the LLM for an advisory recommendation.'),
        hint('4. An auditor sees it and records the final decision on the ledger.')));
      let result;
      const sentJustification = justification.trim();
      try {
        result = await api.access.request({
          recordId: selected.recordId, action, purpose, justification: sentJustification,
        });
      } catch (error) {
        closeAuditorHandoff(auditorHandoff);
        auditorHandoff = null;
        replace(outcome, callout('bad', 'The request could not be recorded',
          hint(error.message),
          hint('No access was granted. A request that cannot be committed grants nothing.')));
        return;
      }
      await showProgress(result);
      // The ledger holds only the justification's fingerprint (h_J). Recomputing it here lets the requester
      // confirm the text they wrote is the text committed.
      const commitment = justificationCommitmentView(sentJustification, result);
      if (commitment.status === 'match') {
        outcome.append(callout('good', 'Your justification is committed unchanged',
          hint('Its fingerprint on the ledger, ', mono(shortHash(commitment.committed, 16)),
            ', matches the text you sent.')));
      } else if (commitment.status === 'mismatch') {
        outcome.append(callout('bad', 'The committed justification fingerprint does not match your text',
          hint('Report this request: the text the auditor and the model receive may not be the '
            + 'text you wrote.')));
      }
      return result;
    };

    const findForm = form({
      submitLabel: 'Search',
      fields: [
        field('Search for', select('kind', [
          { value: 'record', label: 'Case file or record' },
          { value: 'case', label: 'Case number' },
          { value: 'evidence', label: 'Evidence item' },
        ])),
        field('Identifier', input('identifier', {
        placeholder: 'REC-FIR-001, CASE-2026-001 or an evidence ID', required: true, minlength: '1',
        maxlength: '128', pattern: '[A-Za-z0-9._\\-]+', autocomplete: 'off',
        })),
        row(field('Operation', actionInput), field('Purpose', purposeInput)),
        field('Why do you need it?', justificationInput,
          'The LLM and auditor read your reason alongside your verified role and case assignments.'),
      ],
      onSubmit: async (values) => {
        replace(found);
        replace(outcome);
        selected = null;
        const result = await searchForAccess({ api, input: values,
          submit: async (record, intent) => { selected = record; return submitRequest(intent); } });
        if (result.targets.length > 1) {
          let choosing = false;
          replace(found, card('Choose the case file to request',
            'Your search matches several files. Select one to start its access evaluation.',
            table(['Case file', 'Owning station', ''], result.targets.map((record) => [
              mono(record.recordId), record.owningStation,
              button('Request access', { small: true, onclick: async (event) => {
                if (choosing) return;
                const control = event.currentTarget;
                choosing = true;
                control.disabled = true;
                try { selected = record; await submitRequest(result.intent); }
                finally { control.disabled = false; choosing = false; }
              } }),
            ]))));
        }
      },
    });

    const identityCard = card('Signed in as',
      'These attributes come from the enrolled Fabric identity and cannot be changed here.',
      detailTable([
        ['Officer', el('div', {}, el('strong', {}, user.displayName || user.username),
          el('small', { class: 'block' }, `@${user.username}`))],
        ['Role', badge(user.role, 'neutral')],
        ['Organization', ORG_LABEL[user.org] || user.org],
      ]));

    refreshRequests();
    const recentCard = card('My access requests',
      'Your newest 100 requests are read from the blockchain, including earlier sessions.',
      el('div', { class: 'actions' }, button('Refresh', { kind: 'ghost', small: true, onclick: refreshRequests })),
      recent);
    const documentsCard = card('My complete-file requests',
      'When the owning station uploads a requested PDF, the View PDF button appears here.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', small: true, onclick: () => myDocuments.reload() })),
      myDocuments);

    return el('div', { class: 'search-workspace' },
      el('div', { class: 'decision-flow', 'aria-label': 'Decision flow' },
        el('span', {}, '1 · Identifier, operation, purpose, reason'),
        el('span', {}, '2 · Search and request'),
        el('span', {}, '3 · Dynamic authorization check'),
        el('span', {}, '4 · LLM advice on a miss'),
        el('span', {}, '5 · Auditor final decision')),
      grid(identityCard, card('Search and request access',
        'Search checks reusable authorization first. On a miss, the LLM advises the auditor, '
        + 'who makes the final decision. Evidence access uses its parent case-file scope.',
        findForm)),
      found,
      outcome,
      el('section', { class: 'request-history' },
        subheading('History'),
        el('div', { class: 'grid' }, recentCard, documentsCard)));
  },
};
