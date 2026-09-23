/**
 * Evidence chain: attach a commitment, list what is attached, read the private
 * detail. Only the hash is public; narrative detail goes to the
 * `evidenceDetails` private data collection (Police, Forensics, Court).
 */

import { api } from '../core/api.js';
import { FORENSIC_ROLES } from '../core/access.js';
import {
  card, grid, row, field, input, textarea, select, form, table, button, mono, hint,
  slot, replace, attempt, callout,
} from '../core/components.js';
import { dateTime, shortHash } from '../core/format.js';

function attachPanel() {
  const output = slot();

  const body = form({
    submitLabel: 'Attach evidence',
    fields: [
      row(
        field('Record ID', input('recordId', { placeholder: 'FIR-2026-0042', required: true })),
        field('Evidence ID', input('evidenceId', { placeholder: 'EV-DNA-001', required: true })),
      ),
      field('Artifact content', textarea('artifact', {
        required: true, rows: '2',
        placeholder: 'lab artifact bytes — only its SHA-256 goes on-chain',
      }), 'Stored in the agency vault; only its reference and hash go to Fabric.'),
      field('Source', input('source', { required: true, value: 'agency-submission' })),
      field('Private detail', textarea('detail', {
        rows: '2', placeholder: 'goes to the evidenceDetails private collection',
      }), 'Visible to Police, Forensics and Court only.'),
    ],
    onSubmit: async (values, formNode) => {
      const result = await api.evidence.attach(values.recordId.trim(), {
        evidenceId: values.evidenceId.trim(),
        artifact: values.artifact,
        source: values.source,
        ...(values.detail ? { detail: values.detail } : {}),
      });
      replace(output, callout('good', 'Evidence commitment recorded',
        hint('Hash ', mono(shortHash(result.evidenceHash, 20)),
          ' · attached by ', result.attachedByRole)));
      formNode.reset();
    },
  });

  return card('Attach evidence',
    'The public ledger gets only the hash. Detail goes to a private data collection.',
    body, output);
}

function listPanel() {
  const output = slot();
  const detail = slot();

  const body = form({
    submitLabel: 'List evidence',
    fields: [field('Record ID', input('recordId', {
      placeholder: 'FIR-2026-0042', required: true,
    }))],
    onSubmit: async (values) => {
      const recordId = values.recordId.trim();
      const items = await api.evidence.list(recordId);
      replace(detail);
      replace(output, table(['Evidence', 'Hash', 'Custodian', 'By', 'When', ''],
        items.map((item) => [
          mono(item.evidenceId),
          mono(item.evidenceHash, { truncate: true }),
          item.currentCustodianMsp,
          item.attachedByRole,
          dateTime(item.attachedAtUtc),
          row(
            button('Detail', {
              kind: 'ghost', small: true,
              onclick: async () => {
                const found = await attempt(() => api.evidence.detail(recordId, item.evidenceId));
                if (!found) return;
                replace(detail, callout('info', `Private detail for ${item.evidenceId}`,
                  hint(found.detail)));
              },
            }),
            button('Custody', {
              kind: 'ghost', small: true,
              onclick: async () => {
                const events = await attempt(() => api.evidence.custody(recordId, item.evidenceId));
                if (!events) return;
                replace(detail, callout('info', `Custody timeline for ${item.evidenceId}`,
                  events.length
                    ? hint(events.map((event) => `${event.fromMsp} → ${event.toMsp}`).join(' · '))
                    : hint('No custody transfers yet.')));
              },
            }),
          ),
        ]),
        { emptyMessage: 'No evidence attached to that record.' }));
    },
  });

  return card('Evidence chain', 'Commitments on a record, with private detail on demand.',
    body, output, detail);
}

function custodyPanel() {
  const output = slot();
  return card('Transfer evidence custody',
    'Only the current custodian can commit a transfer; chaincode enforces this.',
    form({
      submitLabel: 'Transfer custody',
      fields: [
        row(
          field('Record ID', input('recordId', { required: true, placeholder: 'REC-EVIDENCE-001' })),
          field('Evidence ID', input('evidenceId', { required: true, placeholder: 'EV-DNA-001' })),
        ),
        field('New custodian', select('toMsp', ['PoliceMSP', 'ForensicsMSP', 'CourtMSP'])),
        field('Reason', input('reason', { required: true, placeholder: 'filed as court exhibit' })),
      ],
      onSubmit: async (values) => {
        const event = await api.evidence.transfer(
          values.recordId.trim(), values.evidenceId.trim(),
          { toMsp: values.toMsp, reason: values.reason.trim() }
        );
        replace(output, callout('good', 'Custody transfer committed',
          hint(event.fromMsp, ' → ', event.toMsp, ' · transaction ', mono(event.txId))));
      },
    }), output);
}

export default {
  id: 'evidence',
  title: 'Evidence',
  group: 'Records',
  order: 40,
  // Anyone may list; only forensics may attach, so the attach panel is hidden
  // for others while the list stays available.
  allow: undefined,
  summary: 'Attach and inspect evidence commitments.',

  mount({ user }) {
    const canAttach = FORENSIC_ROLES.includes(user.role);
    return grid(canAttach ? attachPanel() : null, listPanel(),
      ['police', 'forensics', 'court'].includes(user.org) ? custodyPanel() : null);
  },
};
