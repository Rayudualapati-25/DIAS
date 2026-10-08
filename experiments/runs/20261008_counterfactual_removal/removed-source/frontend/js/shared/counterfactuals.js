/** Presentation of verified written-policy hypotheticals, separate from LLM text. */
const AUTHORITIES = Object.freeze({ REQUESTER: 'requester', ADMINISTRATIVE: 'responsible administrator', LEGAL: 'legal authority' });
const NOTICE = 'These are hypothetical conditions under the project’s written research policy. '
  + 'An administrative or legal change needs the responsible authority. The auditor still decides access.';

export function counterfactualView(detail) {
  if (!detail?.explanationVisible || !detail.counterfactuals) return null;
  if (detail.viewer !== 'auditor'
    && !(detail.viewer === 'requester' && detail.decision?.decision === 'FORCE_DENY')) return null;
  const hints = detail.counterfactuals;
  const base = { alternatives: [], blockingClauses: [], notice: NOTICE };
  if (!hints.available) return { ...base, message: 'Policy hints are unavailable: the recorded facts or matching policy could not be verified.' };
  if (hints.writtenPolicy.result === 'ALLOW') return { ...base, message:
    detail.viewer === 'requester'
      ? "The written policy permits these recorded facts. It cannot explain the auditor's denial; no fact change is proposed."
      : 'The written policy permits these recorded facts. No fact change is needed under that policy.' };
  const alternatives = hints.changeSets.map((set) => set.changes.map((change) =>
    `${change.description} — ${AUTHORITIES[change.authority] || 'responsible authority'}`));
  return {
    ...base, alternatives, blockingClauses: hints.writtenPolicy.blockingClauses,
    message: alternatives.length
      ? 'With one of these hypothetical change sets, the recorded facts would satisfy the written policy.'
      : 'No verified change set was found within the two-fact limit or the permitted facts. This does not establish that no other solution exists.',
  };
}
