/**
 * Full reconstruction of one record: every access decision with its explanation,
 * plus the record's own state history from the ledger.
 */

import { api } from '../core/api.js';
import { REVIEWER_ROLES } from '../core/access.js';
import {
  card, grid, field, input, form, table, button, badge, mono, hint, subheading,
  slot, replace, append, el,
} from '../core/components.js';
import { dateTime, shortHash, mspName } from '../core/format.js';
import {
  decisionBadge, explanationCard, plainLanguageBlock,
} from '../shared/explanation.js';

export default {
  id: 'audit-trail',
  title: 'Audit trail',
  group: 'Audit',
  order: 10,
  allow: { roles: REVIEWER_ROLES },
  summary: 'Every decision and explanation recorded for a record.',

  mount() {
    const output = slot();

    const body = form({
      submitLabel: 'Reconstruct trail',
      fields: [field('Record ID', input('recordId', {
        placeholder: 'FIR-2026-0042', required: true,
      }))],
      onSubmit: async (values) => {
        const recordId = values.recordId.trim();
        const trail = await api.audit.trail(recordId);
        const detail = slot();

        const decisions = [...trail.accessDecisions]
          .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
        const recommendations = [...(trail.llmRecommendations || [])]
          .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));
        const auditorDecisions = [...(trail.auditorDecisions || [])]
          .sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));

        const decisionRows = decisions.map((d) => [
          dateTime(d.createdAtUtc),
          `${d.subject.role} (${mspName(d.subject.mspId)})`,
          d.action,
          decisionBadge(d.decision),
          badge(d.status, d.status.startsWith('approved') ? 'allow' : d.status),
          el('div', { class: 'actions tight' },
            button('Why?', {
              kind: 'ghost', small: true,
              onclick: () => {
                replace(detail);
                append(detail,
                  explanationCard(d.explanation),
                  plainLanguageBlock(recordId, d.decisionId));
              },
            }),
            ),
        ]);

        const historyRows = trail.recordHistory.map((h, index) => [
          String(index + 1),
          mono(shortHash(h.txId)),
          h.value
            ? (h.value.sealed ? badge('sealed', 'deny') : badge('open', 'allow'))
            : '—',
          h.value ? dateTime(h.value.sealChangedAtUtc || h.value.createdAtUtc) : '—',
        ]);

        const recommendationRows = recommendations.map((item) => [
          dateTime(item.createdAtUtc),
          mono(item.subject?.username || '—'),
          badge(item.recommendation, item.recommendation),
          mono(item.reasonCode),
          mono(item.modelVersion || '—'),
        ]);

        const auditorRows = auditorDecisions.map((item) => [
          dateTime(item.createdAtUtc),
          mono(item.auditorUsername),
          badge(item.decision, item.finalOutcome === 'allow' ? 'allow' : 'deny'),
          badge(item.finalOutcome, item.finalOutcome),
          item.dynamicPolicyRuleCreated
            ? mono(shortHash(item.dynamicPolicyRuleId, 14)) : 'not created',
        ]);

        const ruleRows = (trail.dynamicAccessRules || []).map((rule) => [
          mono(shortHash(rule.fingerprintHash, 16)),
          `v${rule.ruleVersion}`,
          badge(rule.status, rule.status === 'active' ? 'allow' : 'deny'),
          `${rule.sourceLlmRecommendation} → ${rule.sourceAuditorDecision}`,
          mono(rule.createdByUsername),
        ]);

        replace(output,
          subheading('LLM recommendations (advisory)'),
          table(['When', 'Username', 'Qwen', 'Reason', 'Model'], recommendationRows,
            { emptyMessage: 'No Qwen recommendation was needed for this record.' }),
          subheading('Auditor final decisions'),
          table(['When', 'Auditor', 'Force decision', 'Outcome', 'Dynamic rule'], auditorRows,
            { emptyMessage: 'No DIAS auditor decisions recorded for this record.' }),
          subheading('Access decisions'),
          table(['When', 'Requester', 'Action', 'Decision', 'Status', ''], decisionRows,
            { emptyMessage: 'No decisions recorded for this record.' }),
          detail,
          subheading('Dynamic policy state'),
          table(['Fingerprint', 'Version', 'Status', 'Origin', 'Created by'], ruleRows,
            { emptyMessage: 'No dynamic rule is connected to this record.' }),
          subheading('Record state history'),
          table(['#', 'Transaction', 'Seal state', 'When'], historyRows));
      },
    });

    return grid(card('Audit trail reconstruction',
      'Requests, Qwen advice, auditor authority, dynamic rules, final decisions, and record history from the ledger.',
      body, output));
  },
};
