/**
 * Rendering for the XAI explanation artifact.
 *
 * Shared by search, audit trail and the escalation queue — the same decision
 * must look the same everywhere, so this lives here rather than in one module.
 */

import { el, card, hint, mono, badge, callout, button, slot, replace, append }
  from '../core/components.js';
import { api } from '../core/api.js';
import { attributeList, dateTime, shortHash, mspName } from '../core/format.js';
import { REASON_TEXT, OUTCOME_CONSEQUENCE } from './vocab.js';

/** Coloured pill for the binary outcome. */
export function decisionBadge(decision) {
  return badge(decision, decision);
}

/**
 * The structured artifact: what the policy model decided, why, which trusted
 * attributes mattered, and what would change the outcome. The committed copy
 * comes from the ledger so the model output can be audited later.
 */
export function explanationCard(explanation, { title } = {}) {
  if (!explanation) return null;
  return el('div', { class: 'explain' },
    el('div', { class: 'explain-why' },
      title || `Why ${explanation.decision}? `,
      title ? '' : (REASON_TEXT[explanation.reasonCode] || explanation.reasonCode)),
    el('dl', { class: 'explain-fields' },
      el('dt', {}, 'Reason code'), el('dd', {}, mono(explanation.reasonCode)),
      el('dt', {}, 'Decisive attributes'), el('dd', {}, attributeList(explanation.decisiveAttributes)),
      el('dt', {}, 'Counterfactual'), el('dd', {}, explanation.counterfactual || 'not applicable'),
      el('dt', {}, 'Policy version'), el('dd', {}, mono(explanation.policyVersion))));
}

/**
 * The AI's plain-language wording.
 *
 * The decision is NOT made here — it was already produced by the fine-tuned
 * policy model, validated, and committed to the ledger. This asks the backend
 * to reword that recorded decision. If the wording model is unavailable or
 * says something unsupported, the backend uses template wording.
 */
export function plainLanguageBlock(recordId, decisionId) {
  const body = el('p', { class: 'plain-body loading' }, 'Generating…');
  const meta = slot({ class: 'plain-meta' });

  const container = el('div', { class: 'explain plain' },
    el('div', { class: 'explain-why' }, 'In plain language'),
    body, meta);

  api.explain.decision(recordId, decisionId)
    .then((result) => {
      body.textContent = result.text;
      body.classList.remove('loading');
      replace(meta);
      append(meta,
        result.source === 'llm'
          ? badge(`explanation helper · ${result.model}`, 'neutral')
          : badge('template wording', 'neutral'),
        result.cached ? badge('cached', 'neutral') : null,
        result.latencyMs ? el('small', {}, `${result.latencyMs} ms`) : null,
        result.problems?.length
          ? el('small', { class: 'block' }, `Model output rejected: ${result.problems.join('; ')}`)
          : null,
        result.warnings?.length
          ? el('small', { class: 'block' }, `Note: ${result.warnings.join('; ')}`)
          : null);
    })
    .catch((error) => {
      body.classList.remove('loading');
      body.textContent = 'Plain-language wording is unavailable. The structured '
        + 'explanation above is unaffected.';
      replace(meta, el('small', {}, error.message));
    });

  return container;
}

/**
 * Full decision view: header, structured artifact, AI wording, and what happens
 * next. Used wherever a single decision needs to be shown in detail.
 */
export function decisionDetail(decision, { extra } = {}) {
  const decisionModel = decision.explanation?.modelVersion || decision.inference?.modelVersion;
  const authority = decision.decisionAuthority === 'llm-policy-safety-escalation'
    ? 'Qwen + policy safety guard'
    : decision.decisionAuthority === 'fine-tuned-llm'
      ? 'Fine-tuned Qwen3-14B-4bit'
      : decision.decisionAuthority;
  return el('div', { class: 'decision-detail' },
    el('div', { class: 'decision-head' },
      el('strong', {}, 'Decision '), decisionBadge(decision.decision),
      hint('recorded on-chain as ', mono(shortHash(decision.decisionId, 20)),
        ' · ', dateTime(decision.createdAtUtc)),
      decisionModel
        ? el('div', { class: 'plain-meta' },
          badge(authority || 'Fine-tuned Qwen decision', 'allow'),
          badge(decisionModel, 'neutral'),
          decision.inference?.latencyMs
            ? el('small', {}, `${decision.inference.latencyMs} ms inference`)
            : null)
        : null,
      // The request and the decision are two transactions signed by two different
      // organisations. Showing both is the point: it is what proves the model
      // answered as itself rather than under the requester's certificate.
      decision.decidedByMsp
        ? hint('answered by ', badge(mspName(decision.decidedByMsp), 'neutral'),
          ' · request ', mono(shortHash(decision.requestId, 10)),
          ' · decision ', mono(shortHash(decision.decisionId, 10)))
        : null),
    explanationCard(decision.explanation),
    plainLanguageBlock(decision.recordId, decision.decisionId),
    extra || hint(OUTCOME_CONSEQUENCE[decision.status] || ''));
}

/** One decision as table cells: [when, who, action, decision, reason]. */
export function decisionRow(decision) {
  return [
    dateTime(decision.createdAtUtc),
    `${decision.subject.role} (${mspName(decision.subject.mspId)})`,
    decision.action,
    decisionBadge(decision.decision),
    mono(decision.explanation.reasonCode),
  ];
}


export { card };
