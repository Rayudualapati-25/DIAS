'use strict';

// v3 intentionally commits the recommendation value, signature and hashes.
// Only the explanation/justification/note payload remains off-chain.
const PRIVATE_FIELDS = new Set([
  'justification', 'reason', 'reasonCode', 'reason_code', 'policyRefs', 'policy_refs',
  'missingEvidence', 'missing_evidence', 'reviewFlags', 'review_flags', 'provenance',
  'recommendationObject', 'rawOutput', 'messages', 'prompt',
  'auditorNote', 'note', 'noteText', 'justificationText', 'reasonText',
]);

function ledgerLeaks(value, prefix = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const location = prefix ? `${prefix}.${key}` : key;
    return PRIVATE_FIELDS.has(key) && item != null
      ? [location] : ledgerLeaks(item, location);
  });
}

module.exports = { ledgerLeaks };
