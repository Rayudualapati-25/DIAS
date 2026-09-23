/** Ledger-backed cases, assignments, and prosecution/court workflow metadata. */

import { api } from '../core/api.js';
import { canAdvanceCaseWorkflow, canCreateCase } from '../core/access.js';
import {
  card, grid, row, field, input, select, form, table, button, badge, hint,
  mono, asyncRegion, slot, replace, callout, el,
} from '../core/components.js';
import { dateTime } from '../core/format.js';

export default {
  id: 'cases',
  title: 'Cases',
  group: 'Records',
  order: 5,
  summary: 'Case ownership, assignments, protections, and court workflow on Fabric.',

  mount({ user }) {
    const output = slot();
    const region = asyncRegion({
      load: () => api.cases.list(),
      render: (items) => table(
        ['Case', 'Agency', 'Jurisdiction', 'Status', 'Assigned users', 'Protections'],
        items.map((item) => [
          mono(item.caseId), item.owningAgency, item.jurisdiction,
          badge(item.status, item.status === 'closed' ? 'neutral' : 'allow'),
          (item.assignedUsers || []).join(', ') || '—',
          (item.protectedClassifications || []).join(', ') || '—',
        ]),
        { emptyMessage: 'No case assets are on the ledger.' }
      ),
    });

    const createPanel = canCreateCase(user)
      ? card('Create case', 'The chaincode verifies the police identity and case ownership.',
        form({
          submitLabel: 'Create case',
          fields: [
            row(
              field('Case ID', input('caseId', { required: true, placeholder: 'CASE-2026-003' })),
              field('Jurisdiction', input('jurisdiction', { required: true, value: 'district-north' })),
            ),
            field('Assigned users', input('assignedUsers', {
              placeholder: 'insp.sharma,io.krishnan',
            }), 'Comma-separated Fabric enrollment IDs'),
            field('Protections', input('protectedClassifications', {
              placeholder: 'juvenile,witness',
            }), 'Allowed: juvenile, witness, victim, sealed'),
          ],
          onSubmit: async (values, node) => {
            const split = (value) => (value || '').split(',').map((v) => v.trim()).filter(Boolean);
            const item = await api.cases.create({
              caseId: values.caseId.trim(), jurisdiction: values.jurisdiction.trim(),
              status: 'open', assignedUsers: split(values.assignedUsers),
              protectedClassifications: split(values.protectedClassifications),
            });
            replace(output, callout('good', 'Case committed',
              hint(mono(item.caseId), ' · transaction ', mono(item.txId))));
            node.reset();
            region.reload();
          },
        })) : null;

    const workflowPanel = canAdvanceCaseWorkflow(user)
      ? card('Advance case workflow',
        'Prosecution/police can file to court; only court can close a filed case.',
        form({
          submitLabel: 'Record workflow event',
          fields: [
            row(
              field('Case ID', input('caseId', { required: true, placeholder: 'CASE-2026-001' })),
              field('Next status', select('nextStatus', ['filed-to-court', 'closed'])),
            ),
            field('Reference', input('reference', { required: true, placeholder: 'FILING-2026-001' })),
            field('Note', input('note', { placeholder: 'optional workflow note' })),
          ],
          onSubmit: async (values) => {
            const event = await api.cases.advance(values.caseId.trim(), {
              nextStatus: values.nextStatus, reference: values.reference.trim(), note: values.note,
            });
            replace(output, callout('info', 'Workflow event committed',
              hint(event.fromStatus, ' → ', event.nextStatus, ' · ', mono(event.txId))));
            region.reload();
          },
        })) : null;

    return grid(createPanel, workflowPanel,
      card('Case registry', 'Authoritative case metadata from GovernanceContract.',
        el('div', { class: 'actions' },
          button('Refresh', { kind: 'ghost', onclick: () => region.reload() })),
        region), output);
  },
};
