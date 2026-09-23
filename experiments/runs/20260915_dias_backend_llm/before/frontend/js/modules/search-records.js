/**
 * Requester journey:
 * case or case-file number -> dynamic authorization or model -> auditor -> metadata.
 *
 * Looking up whether an identifier exists is public: case numbers are known and
 * the lookup reads only the public index (identifier and owning station). Nothing
 * protected is read until the requester presses Request access, which is the point at
 * which DIAS starts and the ledger records the request.
 */

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import {
  card, field, input, form, table, detailTable, button, badge, mono, hint,
  slot, replace, attempt, callout, asyncRegion,
} from '../core/components.js';
import { defaultPurpose } from '../shared/vocab.js';
import { decisionDetail } from '../shared/explanation.js';
import { dateTime, shortHash } from '../core/format.js';
import { loadRecentRequests, rememberRequest } from '../shared/recent-requests.js';
import { isSettled, isAutomaticGrant, progressLabel } from '../shared/dias.js';
import {
  prepareAuditorHandoff, completeAuditorHandoff, closeAuditorHandoff,
  openAuditorReview,
} from '../shared/auditor-handoff.js';

const GRANTED_STATUSES = Object.freeze(['granted']);
const LIVE_REQUEST_STATUSES = Object.freeze(['requested', 'ready']);
const PENDING_STATUSES = Object.freeze(['awaiting-recommendation', 'awaiting-auditor', 'requested']);

const granted = (decision) => GRANTED_STATUSES.includes(decision.status);
const byDynamicAuthorization = (decision) =>
  decision.decisionAuthority === 'dynamic-authorization';
const statusKind = (status) => (GRANTED_STATUSES.includes(status) ? 'allow'
  : PENDING_STATUSES.includes(status) ? 'escalate' : 'deny');
const hasLiveRequest = (items, decisionId) => items.some((item) =>
  item.decisionId === decisionId && LIVE_REQUEST_STATUSES.includes(item.status));

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

export default {
  id: 'search',
  title: 'Search case files',
  group: 'Records',
  order: 20,
  allow: undefined,
  summary: 'Look up a case file, then use dynamic policy or request an auditor decision.',

  mount({ user }) {
    const found = slot({ 'aria-live': 'polite' });
    const outcome = slot({ 'aria-live': 'polite', 'aria-atomic': 'false' });
    const recent = slot();
    let documentItems = [];
    let activeRecordId = null;
    let activeRequestId = null;
    let activeDecisionId = null;
    let auditorHandoff = null;
    let auditorHandoffWasOpened = false;

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
              : hint('Waiting for owner upload'),
          ]));
        requestTable.classList.add('document-request-table');
        return requestTable;
      },
    });

    /** Step 3 — ask the owning station to upload the complete case file. */
    const requestDetail = async (decision, output) => {
      const request = await attempt(
        () => api.records.requestDocument(decision.recordId, decision.decisionId),
        'Request sent to the owning station');
      if (!request) return false;
      myDocuments.reload();
      replace(output, callout('good', 'Full case file requested',
        hint(`${request.owningStation} has been asked to upload the PDF. `
          + 'It appears under "My full-document requests" below once it is ready.')));
      return true;
    };

    let showProgress;

    const recheckProgress = async () => {
      const request = await attempt(() => api.access.accessRequest(activeRequestId));
      if (!request) return;
      // A settled request carries the outcome id that the record-release path
      // needs; an unsettled one carries nothing to read a decision from.
      if (isSettled(request) && request.outcomeId) {
        const decision = await attempt(
          () => api.access.decision(request.recordId, request.outcomeId));
        if (decision) await showProgress(decision);
        return;
      }
      await showProgress(request);
    };

    const showDecision = async (decision) => {
      closeAuditorHandoff(auditorHandoff);
      auditorHandoff = null;
      auditorHandoffWasOpened = false;
      activeRecordId = decision.recordId;
      activeRequestId = decision.requestId || decision.decisionId;
      activeDecisionId = decision.decisionId;
      renderRecent(rememberRequest(user.username, decision));

      if (granted(decision)) {
        const record = await attempt(
          () => api.records.metadata(decision.recordId, decision.decisionId));
        const requestOutput = slot();
        const requestButton = button('Request detail', {
          kind: 'ghost',
          onclick: async () => {
            requestButton.disabled = true;
            const sent = await requestDetail(decision, requestOutput);
            if (sent) requestButton.textContent = 'Requested';
            else requestButton.disabled = false;
          },
        });
        requestButton.disabled = hasLiveRequest(documentItems, decision.decisionId);
        if (requestButton.disabled) requestButton.textContent = 'Requested';

        replace(outcome,
          card('Access granted',
            byDynamicAuthorization(decision)
              ? 'An exact active dynamic authorization granted this request automatically. '
                + 'Neither the policy model nor an auditor was consulted.'
              : 'An AuditMSP auditor granted this request. The decision is on the Fabric ledger.',
            decisionDetail(decision)),
          record && card('Case-file metadata',
            'Released because this exact identity holds an approved view decision on the ledger.',
            metadataView(record),
            el('div', { class: 'actions' }, requestButton),
            requestOutput));
        return;
      }

      replace(outcome,
        card('Access denied',
          'The case file stays closed. An AuditMSP auditor made this decision, and it is '
          + 'recorded on Fabric together with the reason.',
          decisionDetail(decision)));
    };

    const showPending = async (request) => {
      activeRecordId = request.recordId;
      activeRequestId = request.requestId;
      activeDecisionId = null;
      renderRecent(rememberRequest(user.username, request));
      const waitingForAuditor = request.status === 'awaiting-auditor';
      const routedNow = waitingForAuditor
        && completeAuditorHandoff(auditorHandoff, request.requestId);
      if (routedNow) {
        auditorHandoff = null;
        auditorHandoffWasOpened = true;
      }
      replace(outcome,
        card(waitingForAuditor ? 'Waiting for auditor' : 'Waiting for the policy model',
          request.message || (waitingForAuditor
            ? 'The model recorded an advisory answer. It did not grant or deny access.'
            : 'The request is on Fabric, but the model has not answered yet.'),
          callout('warn', progressLabel(request),
            hint(waitingForAuditor
              ? 'An AuditMSP auditor must record Force Allow or Force Deny as the final decision.'
              : 'Nothing is granted while the request is pending.')),
          waitingForAuditor && callout('info',
            auditorHandoffWasOpened ? 'Auditor window opened' : 'Auditor window ready',
            hint(auditorHandoffWasOpened
              ? 'Sign in there as an AuditMSP auditor. The LLM recommendation and this exact request will open automatically.'
              : 'The browser blocked or closed the separate window. Open it with the button below.')),
          el('div', { class: 'actions' },
            button('Check current status', { kind: 'ghost', onclick: recheckProgress }),
            waitingForAuditor && button('Open auditor decision window', {
              onclick: () => openAuditorReview(request.requestId),
            }))));
    };

    showProgress = async (result) => {
      // A decision record (allow/deny with a decisionId) versus a request that
      // has not been settled. Only the former may open the case file.
      if (result.decisionId && ['granted', 'denied'].includes(result.status)) {
        await showDecision(result);
      } else if (isSettled(result) && result.outcomeId) {
        const decision = await attempt(
          () => api.access.decision(result.recordId, result.outcomeId));
        if (decision) await showDecision(decision);
      } else {
        await showPending(result);
      }
    };

    /** Step 2 — the requester asks; an exact authorization skips the model. */
    const getDetail = async (recordId) => {
      closeAuditorHandoff(auditorHandoff);
      auditorHandoff = prepareAuditorHandoff();
      auditorHandoffWasOpened = false;
      replace(outcome, callout('info', `DIAS is evaluating ${recordId}`,
        hint('1. Committing the request and its verified facts on Fabric.'),
        hint('2. Checking the latest active dynamic authorization.'),
        hint('3. On a miss, asking the policy model for an advisory recommendation.'),
        hint('4. Recording it for the auditor, who makes the final decision.'),
        hint('An exact active authorization stops at step 2 and grants immediately.')));
      // "Request access" asks for a metadata read, so the operation is known here and is
      // sent as the canonical action rather than left for the model to infer.
      const purpose = defaultPurpose(user.role);
      let result;
      try {
        result = await api.access.request({
          recordId,
          action: 'view',
          purpose,
          justification: `I need to view the metadata for record ${recordId} for ${purpose}.`,
        });
      } catch (error) {
        closeAuditorHandoff(auditorHandoff);
        auditorHandoff = null;
        auditorHandoffWasOpened = false;
        replace(outcome, /does not exist/.test(error.message)
          ? callout('bad', `No case file called "${recordId}"`,
            hint('Nothing with that number exists on the ledger.'))
          : callout('bad', 'The request could not be recorded', hint(error.message),
            hint('No access was granted. A request that cannot be committed grants nothing.')));
        return;
      }
      await showProgress(result);
    };

    /**
     * Step 1 — does this identifier exist? Public: it reads the case index only,
     * never the protected metadata, and never calls the model.
     */
    const lookUp = async (id) => {
      replace(outcome);
      let filesInCase = null;
      try {
        await api.cases.get(id);
        filesInCase = await api.records.search({ caseId: id });
      } catch {
        filesInCase = null;
      }

      if (filesInCase && filesInCase.length > 0) {
        replace(found, card(`Case ${id}`,
          'DIAS evaluates one case file at a time. Choose the file you need.',
          table(['Case file', 'Owning station', ''], filesInCase.map((item) => [
            mono(item.recordId),
            item.owningStation,
            button('Request access', { small: true, onclick: () => getDetail(item.recordId) }),
          ]))));
        return;
      }
      if (filesInCase) {
        replace(found, callout('warn', `Case ${id} has no case files yet`,
          hint('The case exists, but nothing has been filed in it. '),
          hint('Use "File a record" to add a case file, then look it up here.')));
        return;
      }
      let record;
      try {
        record = await api.records.lookup(id);
      } catch {
        record = null;
      }
      if (!record) {
        replace(found, callout('bad', `No case or case file called "${id}"`,
          hint('Check the identifier and try again. No access request was submitted.')));
        return;
      }
      replace(found, card(`Case file ${record.recordId}`,
        `Found in the public index · owned by ${record.owningStation}. Nothing protected has `
          + 'been read yet. Request access to start DIAS and create the ledger request.',
        el('div', { class: 'actions' },
          button('Request access', { onclick: () => getDetail(record.recordId) }))));
    };

    const renderRecent = (entries) => {
      replace(recent, table(['Case file', 'Decision', 'Status', 'When', ''],
        entries.map((entry) => [
          mono(entry.recordId),
          badge(entry.decision || 'waiting', entry.decision || 'pending'),
          badge(entry.status, statusKind(entry.status)),
          dateTime(entry.createdAtUtc),
          button('Open', {
            small: true,
            kind: 'ghost',
            onclick: () => {
              activeRecordId = entry.recordId;
              activeRequestId = entry.requestId || entry.decisionId;
              activeDecisionId = entry.decisionId;
              return recheckProgress();
            },
          }),
        ]),
        { emptyMessage: 'No requests in this session yet.' }));
    };

    const searchForm = form({
      submitLabel: 'Search',
      fields: [field('Case or case-file number', input('recordId', {
        placeholder: 'CASE-2026-001 or REC-FIR-001', required: true, minlength: '1',
        maxlength: '128', pattern: '[A-Za-z0-9._-]+', autocomplete: 'off',
      }), 'Looking a number up is public and is logged as a search. A DIAS access request is created only when you press Request access.')],
      onSubmit: ({ recordId }) => lookUp(recordId.trim()),
    });

    const recentCard = card('My recent requests',
      'Requests made by this identity in the current browser session. Open one to read its '
      + 'current status from the ledger — for example, whether the auditor has decided.',
      recent);
    recentCard.classList.add('search-recent-requests');
    renderRecent(loadRecentRequests(user.username));

    const documentRequestsCard = card('My full-document requests',
      'When the owning police station uploads a requested PDF, the View PDF button appears here.',
      el('div', { class: 'actions' },
        button('Refresh requests', { kind: 'ghost', small: true, onclick: () => myDocuments.reload() })),
      myDocuments);
    documentRequestsCard.classList.add('search-document-requests');

    return el('div', { class: 'search-workspace' },
      card('Find a case or case file',
        'Your blockchain login supplies your organization, role, clearance and assignment. '
        + 'Qwen cannot replace those facts with text typed by a user.',
        searchForm),
      found,
      outcome,
      recentCard,
      documentRequestsCard);
  },
};
