/**
 * Court seal / unseal. Sealing is a verified fact in every later DIAS request for
 * the record, and a decision on a request made before the change is refused.
 */

import { api } from '../core/api.js';
import { ALLOW } from '../core/access.js';
import {
  card, grid, field, input, button, badge, mono, hint, slot, replace, attempt, el,
} from '../core/components.js';

export default {
  id: 'seal-record',
  title: 'Seal a record',
  group: 'Review',
  order: 20,
  allow: ALLOW.SEAL,
  summary: 'Seal or unseal a record. The seal becomes a verified fact in every later access request.',

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
          ? '. Later access requests carry the seal as a verified fact for the LLM and the auditor.'
          : '. Later access requests carry the unsealed state as a verified fact.'));
    };

    return grid(card('Seal or unseal a record',
      'The seal is part of the verified facts of every later access request. A pending request '
      + 'decided after the change is refused, so the requester must ask again.',
      field('Record ID', recordInput),
      el('div', { class: 'actions' },
        button('Seal', { onclick: () => act(true) }),
        button('Unseal', { kind: 'ghost', onclick: () => act(false) })),
      output));
  },
};
