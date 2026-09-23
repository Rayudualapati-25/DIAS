/** Turn the safe, structured Fabric access-event target into a compact label. */
export function accessTargetSummary(target) {
  if (!target || typeof target !== 'object') return '—';
  const parts = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null && value !== '') parts.push(`${label} ${value}`);
  };
  add('record', target.recordId);
  add('request', target.requestId);
  add('decision', target.decisionId);
  add('authorization', target.authorizationId);
  add('case', target.caseId);
  add('action', target.action);
  add('purpose', target.purpose);
  if (target.filters && typeof target.filters === 'object') {
    const filters = Object.entries(target.filters)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
    if (filters) parts.push(`search ${filters}`);
  }
  return parts.join(' · ') || '—';
}
