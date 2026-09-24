/**
 * Requester console.
 *
 * The browser supplies only a record selection, the action and purpose, and a
 * free-text justification. Every attribute that matters to the policy comes from
 * Fabric: the signed-in user's enrolled identity and the record's committed
 * metadata. An exact active dynamic authorization settles the request outright;
 * otherwise the model records advice and an auditor makes the final decision.
 *
 * This screen never presents a model recommendation as an outcome.
 */

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import {
  card, row, field, textarea, select, form, badge, mono, hint, slot, replace,
  callout, detailTable, button,
} from '../core/components.js';
import { ORG_LABEL } from '../core/access.js';
import { defaultPurpose, ACTIONS, PURPOSES, OUTCOME_CONSEQUENCE, requestActionLabel, purposeLabel } from '../shared/vocab.js';
import { dateTime, shortHash } from '../core/format.js';
import {
  decisionAuthorityLabel, isSettled, isAutomaticGrant, progressLabel,
} from '../shared/dias.js';
import {
  prepareAuditorHandoff, completeAuditorHandoff, closeAuditorHandoff,
  openAuditorReview,
} from '../shared/auditor-handoff.js';

const loadingOption = (label) => el('option', { value: '' }, label);

function setOptions(control, items, valueOf, labelOf, emptyLabel) {
  replace(control);
  if (items.length === 0) {
    control.append(loadingOption(emptyLabel));
    control.disabled = true;
    return;
  }
  for (const item of items) {
    control.append(el('option', { value: valueOf(item) }, labelOf(item)));
  }
  control.disabled = false;
}

function identityPanel(user) {
  const initials = String(user.displayName || user.username)
    .split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  return card('Registered user',
    'These attributes come from the enrolled Fabric identity and cannot be changed in the query.',
    el('div', { class: 'identity-summary' },
      el('div', { class: 'identity-avatar', 'aria-hidden': 'true' }, initials),
      el('div', { class: 'identity-copy' },
        el('strong', {}, user.displayName || user.username),
        el('span', {}, `@${user.username}`),
        el('div', { class: 'identity-badges' },
          badge(user.role, 'neutral'),
          badge(ORG_LABEL[user.org] || user.org, 'neutral')))));
}

/** A committed outcome. The authority is the auditor, or an active authorization. */
function outcomeResult(request, record, user) {
  const granted = request.status === 'granted';
  const automatic = isAutomaticGrant(request);
  const check = request.dynamicAuthorizationCheck || {};
  return card('Access decision',
    'The decision and its provenance are committed on Hyperledger Fabric.',
    el('div', { class: `llm-verdict ${granted ? 'allow' : 'deny'}` },
      el('div', { class: 'llm-verdict-label' }, `${decisionAuthorityLabel(request)} decided`),
      el('div', { class: 'llm-verdict-value' }, granted ? 'GRANTED' : 'DENIED'),
      el('p', {}, OUTCOME_CONSEQUENCE[granted ? 'granted' : 'denied'])),
    automatic
      ? callout('info', 'Decided automatically',
        hint('An active dynamic authorization matched this exact request, so neither the '
          + 'policy model nor an auditor was consulted. Authorization ',
          mono(String(check.authorizationId || '—')), '.'))
      : callout('info', 'Decided by an auditor',
        hint('The policy model recommendation was advisory. An AuditMSP auditor made this '
          + 'decision.')),
    el('div', { class: 'decision-context-grid' },
      el('div', {},
        el('span', { class: 'context-label' }, 'Authenticated requester'),
        el('strong', {}, user.displayName || user.username),
        el('small', {}, `${user.role} · ${ORG_LABEL[user.org] || user.org}`)),
      el('div', {},
        el('span', { class: 'context-label' }, 'Protected resource'),
        el('strong', {}, record.recordId),
        el('small', {}, `${record.owningAgency || 'owning organization'} · ${record.owningStation}`)),
      el('div', {},
        el('span', { class: 'context-label' }, 'Requested as'),
        el('strong', {}, `${requestActionLabel(request.action)} · ${purposeLabel(request.purpose)}`),
        el('small', {}, String(request.caseId || '')))),
    detailTable([
      ['Deciding authority', decisionAuthorityLabel(request)],
      ['Processing path', request.processingPath || '—'],
      ['Model consulted', request.llmRecommendationStatus === 'SKIPPED' ? 'no (skipped)' : 'yes (advisory)'],
      ['Auditor consulted', request.auditorReviewStatus === 'SKIPPED' ? 'no (skipped)' : 'yes'],
      ['Request ID', mono(shortHash(request.requestId, 24))],
      ['Access outcome ID', mono(shortHash(request.outcomeId, 24))],
      ['Submitted', dateTime(request.submittedAtUtc)],
    ]),
    callout(granted ? 'good' : 'bad', OUTCOME_CONSEQUENCE[granted ? 'granted' : 'denied']));
}

/**
 * What the model step produced, from the request record alone.
 *
 * The requester's own view of a request does not carry the recommendation — that
 * belongs to the auditor's review — so this reports the STATUS of that step
 * rather than its content. Saying "not yet recorded" for a request whose
 * recommendation exists would be false, and it is the kind of falsehood a
 * requester has no way to check.
 */
function modelStepLabel(request) {
  if (request.llmRecommendationStatus === 'SKIPPED') {
    return 'skipped — an active dynamic authorization decided this request';
  }
  if (request.llmRecommendationStatus === 'PENDING' || !request.recommendationId) {
    return 'not yet recorded';
  }
  if (request.llmRecommendationStatus === 'OK') {
    return 'recorded (advisory) — shown to the auditor, not to the requester';
  }
  return `no recommendation: ${request.llmRecommendationStatus}`;
}

/** Not decided yet. Says what is missing, and never fills the gap with the model's view. */
function pendingResult(request, onCheck, onOpenAuditor, handoffOpened) {
  const waitingForAuditor = request.status === 'awaiting-auditor';
  const failed = waitingForAuditor && request.llmRecommendationStatus !== 'OK'
    && request.llmRecommendationStatus !== 'SKIPPED';
  return card(waitingForAuditor ? 'Waiting for the auditor' : 'Request recorded',
    request.message || 'The request is committed on the ledger.',
    callout('warn', progressLabel(request),
      hint(waitingForAuditor
        ? (failed
          ? 'The policy model produced no recommendation. An auditor must still decide, '
            + 'and must record a reason. No access has been granted or refused yet.'
          : 'The policy model is advisory only. An auditor must now choose Force Allow or '
            + 'Force Deny. No access has been granted or refused yet.')
        : 'No decision exists yet. Nothing is granted while the request is pending.')),
    detailTable([
      ['Request ID', mono(shortHash(request.requestId, 24))],
      ['Ledger status', badge(request.status, 'pending')],
      ['Processing path', request.processingPath || 'llm-auditor'],
      ['Model step', modelStepLabel(request)],
      ['Submitted', dateTime(request.submittedAtUtc)],
    ]),
    waitingForAuditor && callout('info',
      handoffOpened ? 'Auditor window opened' : 'Auditor window ready',
      hint(handoffOpened
        ? 'Sign in as an AuditMSP auditor in the separate window. It will open this exact request.'
        : 'The browser blocked or closed the separate window. Use the button below to open it.')),
    el('div', { class: 'actions' },
      button('Check current status', { kind: 'ghost', onclick: onCheck }),
      waitingForAuditor && button('Open auditor decision window', { onclick: onOpenAuditor })));
}

export default {
  id: 'llm-policy',
  title: 'Ask the LLM',
  group: 'LLM Decision',
  order: 1,
  allow: undefined,
  summary: 'Submit a request; dynamic policy or an auditor makes the final decision.',

  mount({ user }) {
    const caseInput = select('caseId', [], { disabled: true, 'aria-label': 'Case' });
    const recordInput = select('recordId', [], { disabled: true, 'aria-label': 'Record' });
    // The vocabulary is not restated here: both lists come from the shared
    // module, which mirrors the chaincode's frozen ACTIONS and PURPOSES.
    const actionInput = select('action',
      ACTIONS.map((value) => ({ value, label: requestActionLabel(value) })),
      { 'aria-label': 'Operation' });
    const purposeInput = select('purpose',
      PURPOSES.map((value) => ({ value, label: purposeLabel(value) })),
      { 'aria-label': 'Purpose' });
    const justificationInput = textarea('justification', {
      required: true,
      minlength: '3',
      maxlength: '2000',
      rows: '5',
      placeholder: 'Example: I need to view this record for an active investigation.',
      'aria-label': 'Justification for this request',
    });
    const loading = slot({ class: 'llm-loading', 'aria-live': 'polite' });
    const result = slot({ class: 'llm-result', 'aria-live': 'polite', 'aria-atomic': 'false' });
    const recordsById = new Map();
    let justificationEdited = false;
    let auditorHandoff = null;
    let auditorHandoffWasOpened = false;

    actionInput.value = 'view';
    purposeInput.value = defaultPurpose(user.role);
    replace(caseInput, loadingOption('Loading registered cases…'));
    replace(recordInput, loadingOption('Choose a case first'));

    const suggestedJustification = () => {
      const record = recordsById.get(recordInput.value);
      if (!record) return '';
      return `I need to ${actionInput.value} record ${record.recordId} for ${purposeInput.value}.`;
    };


    const setSuggestedJustification = (force = false) => {
      if (force || !justificationEdited || !justificationInput.value.trim()) {
        justificationInput.value = suggestedJustification();
        justificationEdited = false;
      }
    };

    justificationInput.addEventListener('input', () => { justificationEdited = true; });
    recordInput.addEventListener('change', () => setSuggestedJustification());
    actionInput.addEventListener('change', () => setSuggestedJustification());
    purposeInput.addEventListener('change', () => setSuggestedJustification());

    const loadRecords = async (caseId) => {
      recordInput.disabled = true;
      replace(recordInput, loadingOption('Loading protected records…'));
      replace(loading, hint(`Reading record metadata for ${caseId} from Fabric…`));
      try {
        const records = await api.records.search({ caseId });
        recordsById.clear();
        const sorted = [...records].sort((a, b) => a.recordId.localeCompare(b.recordId));
        sorted.forEach((record) => recordsById.set(record.recordId, record));
        setOptions(recordInput, sorted, (record) => record.recordId,
          (record) => `${record.recordId} — ${record.owningStation}`,
          'No records registered for this case');
        replace(loading);
        setSuggestedJustification();
      } catch (error) {
        replace(loading, callout('bad', 'Could not load records', hint(error.message)));
      }
    };

    caseInput.addEventListener('change', () => {
      justificationEdited = false;
      loadRecords(caseInput.value);
    });

    const requestForm = form({
      submitLabel: 'Submit access request',
      fields: [
        row(
          field('Case', caseInput, 'Registered on the permissioned ledger.'),
          field('Protected record', recordInput, 'Only metadata is shown before access is allowed.'),
        ),
        row(
          field('Operation', actionInput, 'The operation you are requesting. Evaluated by the policy check.'),
          field('Purpose', purposeInput, 'The declared purpose. Evaluated by the policy check.'),
        ),
        field('Why do you need it?', justificationInput,
          'This text is untrusted: the auditor sees it, and the model is told not to '
          + 'treat its claims as facts. Your name, role, clearance, case assignments and '
          + 'the record attributes are supplied from Fabric, not from this box.'),
        el('div', { class: 'justification-shortcuts' },
          el('span', {}, 'Quick example:'),
          el('button', {
            class: 'chip', type: 'button',
            onclick: () => {
              actionInput.value = 'view';
              purposeInput.value = defaultPurpose(user.role);
              justificationEdited = false;
              setSuggestedJustification(true);
              justificationInput.focus();
            },
          }, 'View for my normal work'),
          el('button', {
            class: 'chip', type: 'button',
            onclick: () => {
              actionInput.value = 'export';
              justificationInput.value = 'I need to export this record for a public presentation.';
              justificationEdited = true;
              justificationInput.focus();
            },
          }, 'Export for presentation')),
      ],
      onSubmit: async ({ recordId, action, purpose, justification }) => {
        const record = recordsById.get(recordId);
        if (!record) throw new Error('Select a registered record first.');
        closeAuditorHandoff(auditorHandoff);
        auditorHandoff = prepareAuditorHandoff();
        auditorHandoffWasOpened = false;
        replace(result, card('DIAS is evaluating the request…',
          'It first checks the latest committed dynamic authorization, then asks the model only on a miss.',
          el('div', { class: 'model-working', role: 'status' },
            el('span', { class: 'model-working-dot', 'aria-hidden': 'true' }),
            'Dynamic-authorization lookup, then a model recommendation on a miss')));
        try {
          const response = await api.access.request({
            recordId, action, purpose, justification: justification.trim(),
          });
          const show = async (current) => {
            if (isSettled(current)) {
              closeAuditorHandoff(auditorHandoff);
              auditorHandoff = null;
              auditorHandoffWasOpened = false;
              replace(result, outcomeResult(current, record, user));
              return;
            }
            const check = async () => show(await api.access.accessRequest(current.requestId));
            const routedNow = current.status === 'awaiting-auditor'
              && completeAuditorHandoff(auditorHandoff, current.requestId);
            if (routedNow) {
              auditorHandoff = null;
              auditorHandoffWasOpened = true;
            }
            replace(result, pendingResult(
              current,
              check,
              () => openAuditorReview(current.requestId),
              auditorHandoffWasOpened,
            ));
          };
          await show(response);
          result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (error) {
          closeAuditorHandoff(auditorHandoff);
          auditorHandoff = null;
          auditorHandoffWasOpened = false;
          replace(result, callout('bad', 'The access request could not be completed',
            hint(error.message),
            hint('No access was granted. A request that cannot be recorded grants nothing.')));
          throw error;
        }
      },
    });

    api.cases.list()
      .then((cases) => {
        const sorted = [...cases].sort((a, b) => a.caseId.localeCompare(b.caseId));
        setOptions(caseInput, sorted, (item) => item.caseId,
          (item) => `${item.caseId} — ${item.status}`,
          'No registered cases found');
        if (sorted.length > 0) loadRecords(sorted[0].caseId);
      })
      .catch((error) => {
        replace(loading, callout('bad', 'Could not read cases from Fabric', hint(error.message)));
      });

    return el('div', { class: 'llm-console' },
      el('div', { class: 'decision-flow', 'aria-label': 'Decision flow' },
        el('span', {}, '1 · Registered user'),
        el('span', {}, '2 · Action, purpose, justification'),
        el('span', {}, '3 · Dynamic authorization check'),
        el('span', {}, '4 · Model advice on a miss'),
        el('span', {}, '5 · Auditor final decision')),
      el('div', { class: 'llm-console-grid' },
        identityPanel(user),
        card('Request protected data',
          'Choose a record and provide the request model the auditor will review.',
          requestForm, loading)),
      result);
  },
};
