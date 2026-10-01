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

  return el('div', { class: 'login-page' },
    el('header', { class: 'login-topbar' },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'D'),
      el('strong', {}, 'DIAS'),
      el('span', { class: 'login-topbar-divider', 'aria-hidden': 'true' }),
      el('span', {}, 'Crime Records Access Network')),
    el('main', { class: 'login-wrap' },
      el('section', { class: 'login-intro' },
        el('span', { class: 'login-kicker' }, 'SECURE ACCESS PORTAL'),
        el('h1', {}, 'The right access. A clear decision trail.'),
        hint('Request protected records, review exceptions, and trace every decision in one place.'),
        el('div', { class: 'login-features' },
          el('div', {}, el('strong', {}, 'Request'), el('span', {}, 'Submit a record access request')),
          el('div', {}, el('strong', {}, 'Review'), el('span', {}, 'Make an accountable decision')),
          el('div', {}, el('strong', {}, 'Trace'), el('span', {}, 'Follow the recorded outcome')))),
      card('Sign in to DIAS',
        'Select your enrolled identity to enter the portal.', form,
        el('div', { class: 'demo-users' },
          el('h3', {}, 'Enrolled demo identities'),
          el('div', { class: 'account-grid' }, chips)),
        hint('Prototype mode: this backend holds demo identity keys. Production deployment requires independent key custody.'))));
}
