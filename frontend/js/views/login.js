/**
 * Local Fabric-identity selector. Demo accounts are one-click chips so a
 * reviewer can switch departments quickly during a walkthrough.
 */

import { api } from '../core/api.js';
import { el } from '../core/dom.js';
import { card, field, input, button, hint } from '../core/components.js';
import { toast } from '../core/toast.js';

/**
 * Kept in sync with the roster in scripts/seed-users-onchain.js, which is what
 * writes these profiles onto the ledger. If sign-in cannot verify any of them,
 * their Fabric identities or ledger profiles are missing — run
 * `make seed-users`.
 */
const DEMO_ACCOUNTS = Object.freeze([
  ['insp.sharma', 'Insp. A. Sharma', 'Police · Inspector'],
  ['io.krishnan', 'IO S. Krishnan', 'Police · Investigating officer'],
  ['const.verma', 'Const. R. Verma', 'Police · Constable'],
  ['sho.reddy', 'Insp. K. Reddy', 'Police · Station head (PS-Central)'],
  ['insp.rathore', 'Insp. V. Rathore', 'Police · Revoked credential test'],
  ['insp.singh', 'Insp. P. Singh', 'Police · Cross-district test'],
  ['analyst.rao', 'Analyst P. Rao', 'Forensics · Lab analyst'],
  ['dir.iyer', 'Dir. M. Iyer', 'Forensics · Lab director'],
  ['pp.mehta', 'PP D. Mehta', 'Prosecution · Public prosecutor'],
  ['dc.nair', 'Adv. L. Nair', 'Prosecution · Defense counsel'],
  ['judge.rana', 'Hon. Justice Rana', 'Court · Judge'],
  ['clerk.das', 'Clerk B. Das', 'Court · Court clerk'],
  ['sp.north', 'SP (district-north)', 'Authority · District head'],
  ['sp.south', 'SP (district-south)', 'Authority · District head'],
  ['dj.north', 'District Judge', 'Authority · District head'],
  ['ci.central', 'Circle Insp. (PS-Central)', 'Authority · Station head'],
]);

export function loginView(onSignedIn) {
  const username = input('username', { placeholder: 'insp.sharma', autocomplete: 'username' });
  const submit = button('Use Fabric identity', { type: 'submit' });

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        onSignedIn(await api.auth.login(username.value.trim()));
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        submit.disabled = false;
      }
    },
  },
  field('Enrolled identity', username,
    'The local backend signs a Fabric identity check with this certificate.'),
  el('div', { class: 'actions' }, submit));

  const chips = DEMO_ACCOUNTS.map(([user, name, role]) =>
    el('button', {
      class: 'account-chip', type: 'button', title: `Use ${user}`,
      onclick: () => { username.value = user; username.focus(); },
    },
    el('strong', {}, name),
    el('span', {}, role),
    el('code', {}, `@${user}`)));

  return el('div', { class: 'login-wrap' },
    el('h1', {}, 'Crime Records Access Network'),
    hint('Permissioned Hyperledger Fabric network for inter-agency access governance. ',
      'No application password database is used.'),
    card('Select a local Fabric identity',
      'Development mode: certificates and private keys are held by this local backend. '
      + 'Production users should prove possession of a client-held key.', form,
      el('div', { class: 'demo-users' },
        el('h3', {}, 'Enrolled demo identities'),
        el('div', { class: 'account-grid' }, chips))));
}
