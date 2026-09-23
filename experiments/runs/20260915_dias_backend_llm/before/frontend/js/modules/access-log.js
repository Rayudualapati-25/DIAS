/**
 * The access log: who searched, who read a record, who received a case file.
 *
 * Authenticated requests are submitted directly as Fabric transactions. There
 * is no external access-log database or anchoring step.
 */

import { api } from '../core/api.js';
import { REVIEWER_ROLES } from '../core/access.js';
import {
  card, grid, table, button, badge, mono, hint, callout, slot, replace,
  asyncRegion, attempt, el,
} from '../core/components.js';
import { dateTime, actor, count } from '../core/format.js';
import { actionLabel, outcomeKind } from '../shared/vocab.js';
import { accessTargetSummary } from '../shared/access-log.js';

export default {
  id: 'access-log',
  title: 'Access log',
  group: 'Audit',
  order: 30,
  allow: { roles: REVIEWER_ROLES },
  summary: 'Searches and reads, with an integrity check against the ledger.',

  mount({ user }) {
    const verdict = slot();
    const region = asyncRegion({
      load: () => api.audit.accessLog(60),
      render: (data) => el('div', {},
        hint(count(data.entries.length, 'entry', 'entries'),
          ' shown · stored directly on the Fabric ledger'),
        table(['Transaction', 'When', 'Who', 'Did what', 'Record / request', 'Outcome'],
          data.entries.map((entry) => [
            entry.txId ? entry.txId.slice(0, 10) : '—',
            dateTime(entry.timestamp),
            actor(entry.actorUsername, entry.actorRole),
            actionLabel(entry.action),
            mono(accessTargetSummary(entry.target)),
            badge(entry.outcome, outcomeKind(entry.outcome)),
          ]),
          { emptyMessage: 'The log is empty.' })),
    });

    const verify = async () => {
      const result = await attempt(() => api.audit.verifyAccessLog());
      if (!result) return;
      replace(verdict, callout(result.ok ? 'good' : 'bad',
        'Log integrity',
        hint('Result: ', badge(result.ok ? 'intact' : 'tampered', result.ok ? 'allow' : 'deny')),
        hint(`${result.entriesChecked} ledger event(s) returned. `
          + 'Integrity is provided by Fabric endorsement, ordering and block hashes.')));
    };

    return grid(card('Access log (searches and reads)',
      'Authenticated searches, DIAS requests, auditor actions and reads are recorded here '
        + 'as direct Fabric transactions. A new entry can take a few seconds to commit.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() }),
        button('Describe integrity', { onclick: verify })),
      verdict, region));
  },
};
