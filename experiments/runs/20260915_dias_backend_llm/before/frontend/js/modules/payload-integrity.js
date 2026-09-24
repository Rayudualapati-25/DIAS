/**
 * Check the off-chain record against its on-chain commitment.
 * This is the check that catches someone editing the agency database directly.
 */

import { api } from '../core/api.js';
import { REVIEWER_ROLES } from '../core/access.js';
import {
  card, grid, field, input, form, mono, hint, boolBadge, callout, slot, replace,
} from '../core/components.js';
import { shortHash, dateTime } from '../core/format.js';

export default {
  id: 'payload-integrity',
  title: 'Payload integrity',
  group: 'Audit',
  order: 20,
  allow: { roles: REVIEWER_ROLES },
  summary: 'Re-hash agency storage and compare with the ledger commitment.',

  mount() {
    const output = slot();

    const body = form({
      submitLabel: 'Verify payload integrity',
      fields: [field('Record ID', input('recordId', {
        placeholder: 'FIR-2026-0042', required: true,
      }))],
      onSubmit: async (values) => {
        const result = await api.audit.verifyPayload(values.recordId.trim());
        replace(output, callout(result.match ? 'good' : 'bad',
          'Off-chain payload vs on-chain commitment',
          hint('Result: ', boolBadge(result.match),
            ' · committed hash ', mono(shortHash(result.storedHash))),
          hint(result.match
            ? 'The stored record is byte-identical to what was committed when it was filed.'
            : 'The off-chain record no longer matches its commitment — it was changed after filing.'),
          hint('Checked ', dateTime(result.verifiedAt))));
      },
    });

    return grid(card('Payload integrity check',
      'Re-hashes what agency storage holds right now and compares it with the ledger.',
      body, output));
  },
};
