/** Department/agency assets and permitted functions from Fabric. */

import { api } from '../core/api.js';
import {
  ADMINISTRATION_ORGS, ORG_LABEL, canAdministerOfficers,
} from '../core/access.js';
import {
  card, grid, field, input, select, form, table, button, badge, asyncRegion, el,
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

    // GovernanceContract.CreateDepartment: registering any department is an act of
    // a district head of the authority organisation.
    const create = canAdministerOfficers(user)
      ? card('Register a department',
        'Bootstrap operation for a department that is not yet on the ledger. The '
        + 'chaincode accepts it only from a district head of the authority organisation.',
        form({
          submitLabel: 'Create department asset',
          fields: [
            field('Department', select('departmentId',
              ADMINISTRATION_ORGS.map((org) => ({ value: org, label: ORG_LABEL[org] })))),
            field('Name', input('name', { required: true, placeholder: 'Police Department' })),
            field('Jurisdiction', input('jurisdiction', { required: true, value: 'district-north' })),
            field('Permitted functions', input('permittedFunctions', {
              required: true, value: 'investigation,record-filing',
            }), 'Comma-separated'),
          ],
          onSubmit: async (values) => {
            await api.departments.create({
              departmentId: values.departmentId,
              name: values.name.trim(),
              type: TYPE[values.departmentId],
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
