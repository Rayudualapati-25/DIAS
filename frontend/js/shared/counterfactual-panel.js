import { callout, el, hint, detailTable } from '../core/components.js';
import { counterfactualView } from './counterfactuals.js';

export function counterfactualPanel(detail) {
  const view = counterfactualView(detail);
  if (!view) return null;
  return callout('info', 'What could change under the written policy',
    el('p', {}, view.message),
    view.blockingClauses.length ? detailTable([['Blocking clauses', view.blockingClauses.join(', ')]]) : null,
    view.alternatives.length ? el('ol', {}, view.alternatives.map((changes) =>
      el('li', {}, changes.join('; ')))) : null,
    hint(view.notice));
}
