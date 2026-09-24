/**
 * Court seal / unseal. A sealed record escalates every non-court access request.
 */

import { api } from '../core/api.js';
import { JUDICIAL_ROLES } from '../core/access.js';
import {
  card, grid, field, input, button, badge, mono, hint, slot, replace, attempt, el,
} from '../core/components.js';

export default {
  id: 'seal-record',
  title: 'Seal a record',
  group: 'Review',
  order: 20,
  allow: { roles: JUDICIAL_ROLES },
  summary: 'Seal or unseal a record. Sealing forces escalation for other agencies.',

  mount() {
    const output = slot();
    const recordInput = input('recordId', { placeholder: 'FIR-2026-0042' });

    const act = async (seal) => {
      const recordId = recordInput.value.trim();
      if (!recordId) return;
      const record = await attempt(
        () => (seal ? api.records.seal(recordId) : api.records.unseal(recordId)),
        seal ? 'Record sealed' : 'Record unsealed');
      if (!record) return;
      replace(output, hint('Record ', mono(record.recordId), ' is now ',
        record.sealed ? badge('sealed', 'deny') : badge('open', 'allow'),
        record.sealed
          ? '. Access requests from other agencies will now escalate.'
          : '. Normal policy evaluation resumes.'));
    };

    return grid(card('Seal or unseal a record',
      'A sealed record escalates every access request that does not come from the court.',
      field('Record ID', recordInput),
      el('div', { class: 'actions' },
        button('Seal', { onclick: () => act(true) }),
        button('Unseal', { kind: 'ghost', onclick: () => act(false) })),
      output));
  },
};
