/** Search submits one explicit scope; it never calls a model or grants access itself. */
export async function searchForAccess({ api, input, submit }) {
  const identifier = String(input.identifier || '').trim();
  const justification = String(input.justification || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(identifier)) throw new Error('Enter a valid file identifier.');
  if (justification.length < 3 || justification.length > 2000) throw new Error('Provide a reason for this request.');
  const intent = { action: input.action, purpose: input.purpose, justification };
  let targets;
  if (input.kind === 'case') targets = await api.records.search({ caseId: identifier });
  else if (input.kind === 'evidence') targets = await api.records.evidenceIndex(identifier);
  else if (input.kind === 'record') targets = [await api.records.lookup(identifier)];
  else throw new Error('Choose a search type.');
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('Case file or evidence not found.');
  // Evidence IDs may occur under several records. Ask the user to choose rather
  // than silently submitting multiple access requests with different scopes.
  const request = targets.length === 1
    ? await (submit || ((record, scope) => api.access.request({ recordId: record.recordId, ...scope })))(targets[0], intent)
    : null;
  return { targets, request, intent };
}
