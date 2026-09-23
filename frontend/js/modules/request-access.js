/**
 * The requester's screen, from finding a case file to opening it.
 *
 *   find a case or case file -> choose the operation, purpose and reason
 *   -> the ledger records the request and checks the exact dynamic authorization
 *   -> a match grants at once; otherwise an auditor decides, advised by the LLM
 *   -> a granted view opens the metadata and the complete-PDF hand-over
 *
 * Looking an identifier up is public: it reads the record index — identifier,
 * case and owning station — and never the protected metadata. Nothing protected
 * is read until the ledger holds a granted decision for this exact identity.
 */

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
import { loadRecentRequests, rememberRequest } from '../shared/recent-requests.js';
import { accessDecisionView, isSettled, progressLabel } from '../shared/dias.js';
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

    let justificationEdited = false;
    const suggestedJustification = () => (selected
      ? `I need to ${actionInput.value} case file ${selected.recordId} for ${purposeInput.value}.` : '');
    const setSuggestedJustification = () => {
      if (!justificationEdited) justificationInput.value = suggestedJustification();
    };
    justificationInput.addEventListener('input', () => { justificationEdited = true; });
    actionInput.addEventListener('change', setSuggestedJustification);
    purposeInput.addEventListener('change', setSuggestedJustification);

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
      replace(recent, table(['Case file', 'Decision', 'Status', 'When', ''],
        entries.map((entry) => [
          mono(entry.recordId),
          badge(entry.decision || 'waiting', entry.decision || 'pending'),
          badge(entry.status, statusKind(entry.status)),
          dateTime(entry.createdAtUtc),
          button('Open', {
            small: true, kind: 'ghost',
            onclick: () => {
              activeRequestId = entry.requestId || entry.decisionId;
              return recheckProgress();
            },
          }),
        ]),
        { emptyMessage: 'No requests in this browser session yet.' }));
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
      const view = accessDecisionView(decision);

      if (!view.granted) {
        replace(outcome, card('Access denied',
          'The case file stays closed. An AuditMSP auditor made this decision, and the ledger '
          + 'holds it together with whether it agreed with the LLM.',
          decisionSummary(decision)));
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
          decisionSummary(decision)),
        record && card('Case-file metadata',
          'Released because this exact identity holds a granted view decision on the ledger.',
          metadataView(record),
          el('div', { class: 'actions' }, requestButton),
          requestOutput));
    };

    const showPending = (request) => {
      activeRequestId = request.requestId;
      renderRecent(rememberRequest(user.username, request));
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
          ]),
          callout('info', auditorHandoffWasOpened ? 'Auditor window opened' : 'Auditor window',
            hint('Sign in to the separate window as a district head of the authority '
              + 'organisation — and not as the identity that raised this request, which the '
              + 'chaincode refuses.')),
          el('div', { class: 'actions' },
            button('Check current status', { kind: 'ghost', onclick: () => recheckProgress() }),
            button('Open auditor decision window', {
              onclick: () => openAuditorReview(request.requestId),
            }))));
    };

    const showProgress = async (result) => {
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
      try {
        result = await api.access.request({
          recordId: selected.recordId, action, purpose, justification: justification.trim(),
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
    };

    const requestForm = form({
      submitLabel: 'Submit access request',
      fields: [
        row(
          field('Operation', actionInput, 'What you want to do with the case file.'),
          field('Purpose', purposeInput, 'The declared purpose. Both are committed with the request.'),
        ),
        field('Why do you need it?', justificationInput,
          'This text is untrusted: the auditor reads it and the LLM is told not to treat its '
          + 'claims as facts. Your role, clearance and case assignments come from Fabric.'),
      ],
      onSubmit: submitRequest,
    });
    const requestCard = card('Request access to the selected case file',
      'Your organization, role, clearance and case assignment come from your Fabric identity.',
      slot({ class: 'selected-record' }), requestForm);
    const selectedLine = requestCard.querySelector('.selected-record');
    requestCard.hidden = true;

    const selectRecord = (record) => {
      selected = record;
      justificationEdited = false;
      setSuggestedJustification();
      replace(selectedLine, callout('info', `Selected ${record.recordId}`,
        hint('Case ', mono(record.caseId || '—'), ' · owning station ', record.owningStation || '—',
          '. Nothing protected has been read yet.')));
      requestCard.hidden = false;
      requestCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    // --- finding ----------------------------------------------------------
    const filesTable = (items) => table(['Case file', 'Owning station', ''], items.map((item) => [
      mono(item.recordId),
      item.owningStation,
      button('Select', { small: true, onclick: () => selectRecord(item) }),
    ]));

    const lookUp = async (id) => {
      replace(outcome);
      requestCard.hidden = true;
      selected = null;
      let filesInCase = null;
      try {
        await api.cases.get(id);
        filesInCase = await api.records.search({ caseId: id });
      } catch {
        filesInCase = null;
      }
      if (filesInCase && filesInCase.length > 0) {
        replace(found, card(`Case ${id}`,
          'DIAS evaluates one case file at a time. Choose the file you need.', filesTable(filesInCase)));
        return;
      }
      if (filesInCase) {
        replace(found, callout('warn', `Case ${id} has no case files yet`,
          hint('The case exists, but nothing has been filed in it. Use "File a record" to add one.')));
        return;
      }
      const record = await attempt(() => api.records.lookup(id));
      if (!record) {
        replace(found, callout('bad', `No case or case file called "${id}"`,
          hint('Check the identifier. Nothing was requested.')));
        return;
      }
      replace(found, card(`Case file ${record.recordId}`,
        `Found in the public index · owned by ${record.owningStation}.`, filesTable([record])));
      selectRecord(record);
    };

    const findForm = form({
      submitLabel: 'Find',
      fields: [field('Case or case-file number', input('recordId', {
        placeholder: 'CASE-2026-001 or REC-FIR-001', required: true, minlength: '1',
        maxlength: '128', pattern: '[A-Za-z0-9._\\-]+', autocomplete: 'off',
      }), 'Looking a number up is public and is logged as a search. A request is created only '
        + 'when you submit the form below.')],
      onSubmit: ({ recordId }) => lookUp(recordId.trim()),
    });

    const identityCard = card('Signed in as',
      'These attributes come from the enrolled Fabric identity and cannot be changed here.',
      detailTable([
        ['Officer', el('div', {}, el('strong', {}, user.displayName || user.username),
          el('small', { class: 'block' }, `@${user.username}`))],
        ['Role', badge(user.role, 'neutral')],
        ['Organization', ORG_LABEL[user.org] || user.org],
      ]));

    renderRecent(loadRecentRequests(user.username));
    const recentCard = card('My requests in this session',
      'Open one to read its current status from the ledger — for example, whether the auditor '
      + 'has decided.', recent);
    const documentsCard = card('My complete-file requests',
      'When the owning station uploads a requested PDF, the View PDF button appears here.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', small: true, onclick: () => myDocuments.reload() })),
      myDocuments);

    return el('div', { class: 'search-workspace' },
      el('div', { class: 'decision-flow', 'aria-label': 'Decision flow' },
        el('span', {}, '1 · Find the case file'),
        el('span', {}, '2 · Operation, purpose, reason'),
        el('span', {}, '3 · Dynamic authorization check'),
        el('span', {}, '4 · LLM advice on a miss'),
        el('span', {}, '5 · Auditor final decision')),
      grid(identityCard, card('Find a case or case file',
        'Case numbers are known to every organization; looking one up reads only the public index.',
        findForm)),
      found,
      requestCard,
      outcome,
      subheading('History'),
      recentCard,
      documentsCard);
  },
};
