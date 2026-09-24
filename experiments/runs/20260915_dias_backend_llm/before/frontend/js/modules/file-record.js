/**
 * File a new case record.
 *
 * The narrative goes to agency storage off-chain; only metadata and a SHA-256
 * commitment reach the ledger.
 */

import { api } from '../core/api.js';
import { FILING_ROLES } from '../core/access.js';
import {
  card, grid, row, field, input, textarea, select, checkbox, form, hint, mono,
  slot, replace, callout,
} from '../core/components.js';
import { RECORD_TYPES, SENSITIVITY } from '../shared/vocab.js';
import { shortHash } from '../core/format.js';

export default {
  id: 'file-record',
  title: 'File a record',
  group: 'Records',
  order: 10,
  allow: { roles: FILING_ROLES },
  summary: 'Register a new case record. The narrative stays off-chain.',

  mount({ user }) {
    const output = slot();

    const body = form({
      submitLabel: 'File record',
      fields: [
        row(
          field('Record ID', input('recordId', {
            placeholder: 'FIR-2026-0042', required: true,
          }), 'Letters, numbers, dot, dash, underscore'),
          field('Case ID', input('caseId', { value: 'CASE-2026-001', required: true })),
        ),
        row(
          field('Record type', select('recordType', RECORD_TYPES)),
          field('Sensitivity', select('sensitivityLevel', SENSITIVITY)),
        ),
        field('Summary', textarea('summary', {
          required: true,
          placeholder: 'Goes to agency storage only — never to the ledger',
        }), 'Stored off-chain. Only its hash is committed.'),
        field('Complainant reference', input('complainant', {
          placeholder: 'internal reference',
        })),
        row(
          field('Owning station', input('owningStation', { value: 'PS-Central', required: true })),
          field('Jurisdiction', input('jurisdiction', { value: 'district-north', required: true })),
        ),
        row(
          checkbox('juvenileFlag', 'Juvenile involved'),
          checkbox('witnessFlag', 'Witness information'),
        ),
        checkbox('victimProtectionFlag', 'Victim identity/address protected'),
      ],
      onSubmit: async (values, formNode) => {
        const record = await api.records.create({
          recordId: values.recordId.trim(),
          payload: {
            fir: values.recordId.trim(),
            summary: values.summary,
            complainant: values.complainant,
            filedBy: user.username,
          },
          meta: {
            caseId: values.caseId.trim(),
            recordType: values.recordType,
            sensitivityLevel: values.sensitivityLevel,
            juvenileFlag: values.juvenileFlag,
            witnessFlag: values.witnessFlag,
            victimProtectionFlag: values.victimProtectionFlag,
            owningStation: values.owningStation.trim(),
            jurisdiction: values.jurisdiction.trim(),
          },
        });
        replace(output, callout('good', 'Record committed to the ledger',
          hint('Record ', mono(record.recordId),
            ' · content hash ', mono(shortHash(record.contentHash)),
            ' · transaction ', mono(shortHash(record.createdTxId)))));
        formNode.reset();
      },
    });

    return grid(card('File a case record',
      'Metadata and a SHA-256 commitment go on-chain. The narrative stays in agency storage.',
      body, output));
  },
};
