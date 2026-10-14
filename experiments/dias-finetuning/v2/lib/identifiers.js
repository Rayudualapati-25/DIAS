'use strict';

/** Neutral identifiers. */

const crypto = require('crypto');

const HEX = /^[0-9a-f]+$/;

function createIdentifierFactory(seed) {
  const counters = new Map();

  function token(kind, width) {
    const index = (counters.get(kind) || 0) + 1;
    counters.set(kind, index);
    // The salt is mixed in first so the digest is not a function of the index alone: without it,
    // identifiers would be comparable across runs and an adjacent pair would be adjacent in every dataset.
    return crypto.createHash('sha256')
      .update(`${seed}::identifier::${kind}::${index}`)
      .digest('hex')
      .slice(0, width);
  }

  return {
    /** A person. Not derived from name, role, organization or split. */
    username: () => `u-${token('username', 10)}`,
    /** A case. Numeric ranges must never correlate with a label. */
    caseId: () => `CASE-${token('case', 8).toUpperCase()}`,
    /** A record within a case. */
    recordId: () => `REC-${token('record', 10).toUpperCase()}`,
    /** A stable example id, used for split assignment and deduplication. */
    exampleId: () => `EX-${token('example', 12)}`,
    familyId: () => `FAM-${token('family', 10)}`,
  };
}

/** True when a value leaks any of the terms it must not encode. */
function leaksTerms(value, terms) {
  const lowered = String(value).toLowerCase();
  return terms.filter((term) => term && lowered.includes(String(term).toLowerCase()));
}

module.exports = { HEX, createIdentifierFactory, leaksTerms };
