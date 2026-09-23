/** Department/agency assets and permitted functions from Fabric. */

import { api } from '../core/api.js';
import { USER_ADMIN_ROLES, ORG_LABEL } from '../core/access.js';
import {
  card, grid, field, input, form, table, button, badge, asyncRegion, el,
} from '../core/components.js';

const TYPE = Object.freeze({
  police: 'police', forensics: 'forensics', prosecution: 'prosecution',
  court: 'court', audit: 'oversight',
});

export default {
  id: 'departments',
  title: 'Departments',
  group: 'People',
  order: 5,
  summary: 'Agency identity, jurisdiction, status, and permitted functions on Fabric.',

  mount({ user }) {
    const region = asyncRegion({
      load: () => api.departments.list(),
      render: (items) => table(
        ['Department', 'Type', 'Jurisdiction', 'Status', 'Permitted functions'],
        items.map((item) => [
          ORG_LABEL[item.departmentId] || item.name, item.type, item.jurisdiction,
          badge(item.status, item.status === 'active' ? 'allow' : 'deny'),
          item.permittedFunctions.join(', '),
        ]),
        { emptyMessage: 'No department assets are on the ledger.' }
      ),
    });

    const create = USER_ADMIN_ROLES.includes(user.role)
      ? card('Register this department',
        'Bootstrap operation: the chaincode permits only the senior role of that MSP.',
        form({
          submitLabel: 'Create department asset',
          fields: [
            field('Name', input('name', { required: true, value: ORG_LABEL[user.org] })),
            field('Jurisdiction', input('jurisdiction', { required: true, value: 'district-north' })),
            field('Permitted functions', input('permittedFunctions', {
              required: true, value: 'case-review,audit-review',
            }), 'Comma-separated'),
          ],
          onSubmit: async (values) => {
            await api.departments.create({
              departmentId: user.org, name: values.name.trim(), type: TYPE[user.org],
              jurisdiction: values.jurisdiction.trim(),
              permittedFunctions: values.permittedFunctions.split(',')
                .map((value) => value.trim()).filter(Boolean),
            });
            region.reload();
          },
        })) : null;

    return grid(create, card('Department registry',
      'These are governance assets, not frontend-only labels.',
      el('div', { class: 'actions' },
        button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
      region));
  },
};
