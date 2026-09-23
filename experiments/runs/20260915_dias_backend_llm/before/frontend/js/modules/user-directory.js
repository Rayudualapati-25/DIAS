/**
 * Everyone on the ledger.
 *
 * This list is not read from a database — it is a chaincode query over the
 * profiles written by UserContract, so it shows exactly what every department's
 * peer holds. No application password or password hash exists.
 *
 * Revoking is deliberately not a delete. The record stays, its status changes,
 * and both the admission and the revocation remain in the key's history.
 */

import { api } from '../core/api.js';
import { USER_ADMIN_ROLES, ORG_LABEL } from '../core/access.js';
import {
  card, grid, table, button, badge, hint, mono, callout, slot, replace,
  subheading, asyncRegion, attempt, el,
} from '../core/components.js';
import { dateTime, shortHash, count } from '../core/format.js';

const STATUS_KIND = Object.freeze({
  active: 'allow',
  revoked: 'deny',
  suspended: 'escalate',
});

export default {
  id: 'user-directory',
  title: 'Officer directory',
  group: 'People',
  order: 20,
  summary: 'Every account on the ledger, and how it got there.',

  mount({ user }) {
    const detail = slot();
    // The chaincode only lets the senior role in a department change one of
    // its own people. Anything else is hidden here and refused there.
    const mayAdminister = (target) =>
      USER_ADMIN_ROLES.includes(user.role) && target.org === user.org;

    const showHistory = async (username) => {
      const history = await attempt(() => api.users.history(username));
      if (!history) return;
      replace(detail,
        subheading(`History of ${username}`),
        hint('Straight from the ledger — every version of this account, in order.'),
        table(['Transaction', 'Status', 'Role', 'Admitted / changed by'],
          history.map((entry) => [
            mono(shortHash(entry.txId)),
            entry.value
              ? badge(entry.value.credentialStatus,
                STATUS_KIND[entry.value.credentialStatus] || 'neutral')
              : badge('deleted', 'deny'),
            entry.value ? entry.value.role : '—',
            entry.value
              ? mono(shortHash(entry.value.statusChangedBy || entry.value.registeredBy, 28))
              : '—',
          ]),
          { emptyMessage: 'No history for this account.' }));
    };

    // Declared before the region that calls it: the region renders after an
    // await, so a later declaration would happen to work, and would break the
    // moment the data came from a cache.
    const changeStatus = async (username, status) => {
      const updated = await attempt(
        () => api.users.setStatus(username, status),
        `${username} is now ${status}`);
      if (!updated) return;
      replace(detail, callout('info', 'Status changed on the ledger',
        hint(mono(username), ' is now ',
          badge(status, STATUS_KIND[status] || 'neutral'),
          '. The account was not deleted — both the admission and this change '
          + 'stay in its history.')));
      region.reload();
    };

    const region = asyncRegion({
      load: () => api.users.list(),
      render: (accounts) => el('div', {},
        hint(count(accounts.length, 'account'), ' on the ledger'),
        table(['Username', 'Name', 'Department', 'Role', 'Status', 'Admitted', ''],
          accounts.map((account) => [
            mono(account.userId),
            account.displayName,
            ORG_LABEL[account.org] || account.org,
            badge(account.role, 'neutral'),
            badge(account.credentialStatus,
              STATUS_KIND[account.credentialStatus] || 'neutral'),
            account.registeredAt ? dateTime(account.registeredAt) : '—',
            el('div', { class: 'actions' },
              button('History', {
                kind: 'ghost', small: true,
                onclick: () => showHistory(account.userId),
              }),
              mayAdminister(account) && account.credentialStatus === 'active'
                ? button('Revoke', {
                  kind: 'ghost', small: true,
                  onclick: () => changeStatus(account.userId, 'revoked'),
                })
                : null,
              mayAdminister(account) && account.credentialStatus !== 'active'
                ? button('Reinstate', {
                  kind: 'ghost', small: true,
                  onclick: () => changeStatus(account.userId, 'active'),
                })
                : null),
          ]),
          { emptyMessage: 'No accounts on the ledger yet — run `make seed-users`.' })),
    });

    return grid(card('Officer directory',
      'A chaincode query, not a database read. Every department\'s peer holds '
      + 'the same list.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
      region, detail));
  },
};
