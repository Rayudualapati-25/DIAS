/**
 * Look up one record by id: its on-chain metadata, its access decisions, and
 * the off-chain payload if the ledger already holds a granted decision.
 */

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import {
  card, grid, field, input, form, table, detailTable, button, badge, mono, hint,
  subheading, slot, replace, append, attempt,
} from '../core/components.js';
import { dateTime, shortHash } from '../core/format.js';
import { decisionRow } from '../shared/explanation.js';

export default {
  id: 'record-lookup',
  title: 'Record lookup',
  group: 'Records',
  order: 30,
  allow: undefined,
  summary: 'On-chain metadata and decision history for one record.',

  mount() {
    const output = slot();

    const body = form({
      submitLabel: 'Look up',
      fields: [field('Record ID', input('recordId', {
        placeholder: 'FIR-2026-0042', required: true,
      }))],
      onSubmit: async (values) => {
        const recordId = values.recordId.trim();
        const record = await api.records.get(recordId);
        const decisions = await api.access.forRecord(recordId).catch(() => []);

        const flags = [record.juvenileFlag && 'juvenile', record.witnessFlag && 'witness']
          .filter(Boolean).join(', ') || '—';

        const payloadBox = slot();
        const fetchPayload = button('Fetch off-chain payload', {
          kind: 'ghost', small: true,
          onclick: async () => {
            const released = await attempt(() => api.records.payload(recordId));
            if (!released) return;
            replace(payloadBox,
              hint('Released under decision ', mono(shortHash(released.grantedByDecision))),
              el('pre', { class: 'mono block' }, JSON.stringify(released.payload, null, 2)));
          },
        });

        const sorted = [...decisions].sort((a, b) => a.createdAtUtc.localeCompare(b.createdAtUtc));

        replace(output,
          detailTable([
            ['Case', mono(record.caseId)],
            ['Type', record.recordType],
            ['Sensitivity', badge(record.sensitivityLevel, 'neutral')],
            ['Sealed', record.sealed ? badge('sealed', 'deny') : badge('open', 'allow')],
            ['Flags', flags],
            ['Jurisdiction', record.jurisdiction],
            ['Owning station', record.owningStation],
            ['Content hash', mono(record.contentHash, { truncate: true })],
            ['Off-chain reference', mono(record.offChainReference, { truncate: true })],
            ['Filed', dateTime(record.createdAtUtc)],
            ['Filed by role', record.createdByRole],
          ]),
          el('div', { class: 'actions' }, fetchPayload),
          payloadBox,
          subheading('Access decisions'),
          table(['When', 'Requester', 'Action', 'Decision', 'Reason'],
            sorted.map(decisionRow),
            { emptyMessage: 'No access decisions recorded for this record yet.' }));
      },
    });

    return grid(card('Record lookup',
      'On-chain metadata only. The payload is released after a granted decision exists.',
      body, output));
  },
};
