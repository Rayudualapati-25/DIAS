/** Register a new officer. */

import { api } from '../core/api.js';
import {
  ADMINISTRATION_ORGS, ALLOW, ORG_LABEL, ROLES_BY_ORG,
} from '../core/access.js';
import {
  card, grid, row, field, input, select, form, hint, mono, badge,
  slot, replace, callout, el,
} from '../core/components.js';
import { SENSITIVITY } from '../shared/vocab.js';

const departmentOptions = ADMINISTRATION_ORGS.map((org) => ({ value: org, label: ORG_LABEL[org] }));
const roleOptions = (org) => (ROLES_BY_ORG[org] || []).map((role) => el('option', { value: role }, role));

export default {
  id: 'register-user',
  title: 'Register an officer',
  group: 'People',
  order: 10,
  allow: ALLOW.ADMINISTRATOR,
  summary: 'Issue a certificate and write the account onto the ledger.',

  mount({ user }) {
    const output = slot();
    const departmentInput = select('org', departmentOptions, { 'aria-label': 'Department' });
    const roleInput = select('role', ROLES_BY_ORG[departmentInput.value] || [], { 'aria-label': 'Role' });
    departmentInput.addEventListener('change', () => replace(roleInput, roleOptions(departmentInput.value)));

    const body = form({
      submitLabel: 'Register officer',
      fields: [
        row(
          field('Username', input('username', {
            placeholder: 'const.nayak', required: true,
          }), 'Used to sign in, and as the certificate name'),
          field('Display name', input('displayName', {
            placeholder: 'Const. S. Nayak', required: true,
          })),
        ),
        row(
          field('Department', departmentInput, 'Its certificate authority issues the certificate'),
          field('Role', roleInput),
        ),
        row(
          field('Station', input('station', { placeholder: 'PS-Central' })),
          field('Jurisdiction', input('jurisdiction', {
            value: 'district-north', required: true,
          })),
        ),
        row(
          field('Badge number', input('badgeId', { placeholder: 'B-5005' })),
          field('Clearance', select('clearance', SENSITIVITY)),
        ),
        row(
          field('Rank', input('rank', { placeholder: '3' }), 'Numeric, police only'),
          field('Case assignments', input('caseAssignments', {
            placeholder: 'CASE-2026-001|CASE-2026-002',
          }), 'Separate with | — signed into the certificate'),
        ),
      ],
      onSubmit: async (values, formNode) => {
        // Only send what was filled in: an empty attribute would be signed into the certificate as an empty
        // value, which the policy treats as set.
        const optional = {};
        for (const key of ['station', 'badgeId', 'rank', 'caseAssignments']) {
          const value = (values[key] || '').trim();
          if (value) optional[key] = value;
        }

        const account = await api.users.register({
          username: values.username.trim(),
          displayName: values.displayName.trim(),
          org: values.org,
          role: values.role,
          jurisdiction: values.jurisdiction.trim(),
          clearance: values.clearance,
          ...optional,
        });

        replace(output, callout('good', 'Officer registered',
          hint(mono(account.userId), ' now holds a certificate from the ',
            ORG_LABEL[account.org] || account.org, ' CA and an account on the ledger.'),
          hint('Role ', badge(account.role, 'neutral'),
            ' · admitted by ', mono(user.username),
            ' · transaction ', mono(account.txId)),
          hint('They can be selected after their certificate and ledger profile exist.')));
        formNode.reset();
        replace(roleInput, roleOptions(departmentInput.value));
      },
    });

    return grid(card('Register an officer',
      'A Fabric CA certificate, then a transaction that puts the account on the '
      + 'blockchain. Both are required: a certificate with no account cannot sign '
      + 'in, and an account with no certificate cannot sign anything. Only a district '
      + 'head of the authority organisation may admit an officer.',
      body, output));
  },
};
