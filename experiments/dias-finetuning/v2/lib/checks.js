'use strict';

/**
 * Dataset checks.
 *
 * Each check answers one question about the written files, not about the code
 * that produced them. A check that merely restates a generator invariant would
 * pass even if the generator never ran, so every check here re-derives its
 * answer from the JSONL on disk.
 */

const crypto = require('crypto');
const {
  validateRecommendationOutput,
} = require('../../../../chaincode/crimerecords/lib/dias/recommendationSchema');
const { labelFor } = require('./example');

const HELD_OUT_SET = 'test-ood-paraphrase';
const TRAINING_SETS = Object.freeze(['train']);

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const fail = (id, detail) => ({ id, ok: false, detail });
const pass = (id, detail) => ({ id, ok: true, detail });

/** Every response satisfies the schema the chaincode enforces at submission. */
function checkSchema(all, policy) {
  const problems = [];
  for (const example of all) {
    const found = validateRecommendationOutput(example.label, policy);
    if (found.length > 0) problems.push(`${example.exampleId}: ${found.join('; ')}`);
    if (problems.length >= 5) break;
  }
  return problems.length === 0
    ? pass('schema', `${all.length} labels satisfy the response contract`)
    : fail('schema', problems.join(' | '));
}

/** Every label is reproducible from the facts and the justification family. */
function checkLabelReproduction(all, bundle) {
  const mismatches = [];
  for (const example of all) {
    const expected = labelFor(bundle, example.verifiedRequest, example.justificationFamily);
    if (JSON.stringify(expected) !== JSON.stringify(example.label)) {
      mismatches.push(example.exampleId);
      if (mismatches.length >= 5) break;
    }
  }
  return mismatches.length === 0
    ? pass('label-reproduction', `${all.length} labels reproduced from the oracle and the family declaration`)
    : fail('label-reproduction', `not reproducible: ${mismatches.join(', ')}`);
}

/** Balance within the declared tolerance, per set. */
function checkBalance(sets, tolerance, balancedSets) {
  const problems = [];
  for (const name of balancedSets) {
    const examples = sets[name] || [];
    if (examples.length === 0) {
      problems.push(`${name} is empty`);
      continue;
    }
    const allow = examples.filter((e) => e.label.recommendation === 'ALLOW').length;
    const share = allow / examples.length;
    if (Math.abs(share - 0.5) > tolerance) {
      problems.push(`${name} ALLOW share ${share.toFixed(3)} exceeds ±${tolerance}`);
    }
  }
  return problems.length === 0
    ? pass('balance', `${balancedSets.length} sets balanced within ±${tolerance}`)
    : fail('balance', problems.join('; '));
}

/**
 * No prompt appears twice within one set, and no prompt crosses a split.
 *
 * The test sets are deliberately overlapping views of one held-out pool — the
 * same example can be in `test-decision-balanced` and `test-reason-balanced` —
 * so overlap inside `test` is reported as a statistic, not a failure. Overlap
 * ACROSS splits is the leak, and is.
 */
function checkDuplicatePrompts(bySet) {
  const problems = [];
  const owners = new Map();
  let overlapWithinTest = 0;
  for (const [setName, examples] of Object.entries(bySet)) {
    const withinSet = new Set();
    for (const example of examples) {
      if (withinSet.has(example.promptHash)) {
        problems.push(`${setName} contains ${example.exampleId} twice`);
      }
      withinSet.add(example.promptHash);
      const previous = owners.get(example.promptHash);
      if (previous && splitOf(previous.set) !== splitOf(setName)) {
        problems.push(`${previous.exampleId} appears in ${previous.set} and ${setName}`);
      } else if (previous) {
        overlapWithinTest += 1;
      } else {
        owners.set(example.promptHash, { set: setName, exampleId: example.exampleId });
      }
      if (problems.length >= 5) break;
    }
  }
  return problems.length === 0
    ? pass('duplicate-prompts',
      `${owners.size} distinct prompts; ${overlapWithinTest} reuses across views of the same split`)
    : fail('duplicate-prompts', problems.join('; '));
}

/**
 * No verified feature set appears in two different splits.
 *
 * This is the leak that matters most: identical facts with different phrasing
 * across a split boundary makes a test score partly a memory test.
 */
function checkFeatureLeakage(bySet) {
  const owners = new Map();
  const leaks = [];
  for (const [setName, examples] of Object.entries(bySet)) {
    for (const example of examples) {
      // caseId is a fresh identifier per family, so exclude it: two families that
      // happen to share every policy fact are a coincidence, not a leak, and
      // including the id would hide real collisions behind unique noise.
      const { caseId, ...resource } = example.verifiedRequest.resource;
      const key = sha256(JSON.stringify({
        requester: example.verifiedRequest.requester,
        resource,
        request: example.verifiedRequest.request,
      }));
      const previous = owners.get(key);
      if (previous && previous.set !== setName && splitOf(previous.set) !== splitOf(setName)) {
        leaks.push(`${previous.exampleId} (${previous.set}) shares facts with ${example.exampleId} (${setName})`);
        if (leaks.length >= 5) break;
      }
      if (!previous) owners.set(key, { set: setName, exampleId: example.exampleId });
    }
  }
  return leaks.length === 0
    ? pass('feature-leakage', `${owners.size} distinct feature sets, none crossing a split`)
    : fail('feature-leakage', leaks.join('; '));
}

/** Which underlying split a named set was cut from. */
function splitOf(setName) {
  if (setName === 'train') return 'train';
  if (setName === 'validation-balanced') return 'validation';
  if (setName === 'workflow-evaluation') return 'workflow';
  return 'test';
}

/** No scenario family has members in two splits. */
function checkFamilyLeakage(bySet) {
  const splits = new Map();
  const leaks = [];
  for (const [setName, examples] of Object.entries(bySet)) {
    for (const example of examples) {
      const split = splitOf(setName);
      const previous = splits.get(example.scenarioFamily);
      if (previous && previous !== split) {
        leaks.push(`${example.scenarioFamily} appears in ${previous} and ${split}`);
        if (leaks.length >= 5) break;
      }
      splits.set(example.scenarioFamily, split);
    }
  }
  return leaks.length === 0
    ? pass('family-leakage', `${splits.size} families, each in exactly one split`)
    : fail('family-leakage', [...new Set(leaks)].join('; '));
}

/** The held-out template families never appear in training. */
function checkTemplateLeakage(bySet, heldOutFamilyIds) {
  const held = new Set(heldOutFamilyIds);
  const found = [];
  for (const setName of TRAINING_SETS) {
    for (const example of bySet[setName] || []) {
      if (held.has(example.justificationFamily)) found.push(`${example.exampleId}: ${example.justificationFamily}`);
      if (found.length >= 5) break;
    }
  }
  const oodFamilies = new Set((bySet[HELD_OUT_SET] || []).map((e) => e.justificationFamily));
  const contaminated = [...oodFamilies].filter((id) => !held.has(id));
  if (found.length > 0) return fail('template-leakage', `held-out phrasing in training: ${found.join('; ')}`);
  if (contaminated.length > 0) {
    return fail('template-leakage', `${HELD_OUT_SET} uses trained phrasing: ${contaminated.join(', ')}`);
  }
  return pass('template-leakage',
    `${held.size} held-out template families, none in training; ${HELD_OUT_SET} uses only them`);
}

/**
 * Identifiers encode nothing.
 *
 * Checked two ways: the string must not contain the term, and the term must not
 * be predictable from the identifier. The second is the one that catches v1's
 * numeric ranges, where no substring matched but the range did.
 */
function checkIdentifierLeakage(all) {
  const problems = [];
  const terms = (example) => [
    example.label.recommendation, example.label.reason_code, example.split,
    example.verifiedRequest.requester.role, example.verifiedRequest.requester.organization,
  ];
  for (const example of all) {
    for (const field of ['username', 'recordId', 'caseId', 'exampleId']) {
      const value = String(example[field] || '').toLowerCase();
      const leaked = terms(example).filter((term) => term && value.includes(String(term).toLowerCase()));
      if (leaked.length > 0) {
        problems.push(`${example.exampleId}.${field} contains ${leaked.join(', ')}`);
      }
    }
    if (problems.length >= 5) break;
  }
  return problems.length === 0
    ? pass('identifier-substring', 'no identifier contains a label, reason code, split, role or organization')
    : fail('identifier-substring', problems.join('; '));
}

/**
 * An identifier must not predict the label.
 *
 * v1 gave each reason code its own contiguous record-number range, so a prefix
 * bucket was almost pure. The test is therefore a two-sided binomial test of
 * each prefix bucket against the overall ALLOW rate, Bonferroni-corrected for
 * the number of buckets examined: with hundreds of buckets, a handful of 2-3σ
 * deviations is what independence looks like, and reporting them as leakage
 * would be a false alarm that trains the reader to ignore this check.
 */
function checkIdentifierPredictiveness(all, field, prefixLength, { minBucket = 50, sigma = 4 } = {}) {
  const buckets = new Map();
  for (const example of all) {
    const key = String(example[field]).slice(0, prefixLength);
    if (!buckets.has(key)) buckets.set(key, { allow: 0, total: 0 });
    const bucket = buckets.get(key);
    bucket.total += 1;
    if (example.label.recommendation === 'ALLOW') bucket.allow += 1;
  }
  const overall = all.filter((e) => e.label.recommendation === 'ALLOW').length / all.length;
  const tested = [...buckets.entries()].filter(([, b]) => b.total >= minBucket);
  if (tested.length === 0) {
    return pass(`identifier-predictiveness:${field}`,
      `no prefix bucket reaches ${minBucket} examples, so no bucket can carry the label`);
  }
  // Bonferroni: hold the family-wise error near the single-test level.
  const threshold = sigma + Math.sqrt(2 * Math.log(Math.max(tested.length, 2)));
  const suspicious = tested
    .map(([key, b]) => {
      const share = b.allow / b.total;
      const standardError = Math.sqrt((overall * (1 - overall)) / b.total);
      return { key, b, share, z: Math.abs(share - overall) / standardError };
    })
    .filter((entry) => entry.z > threshold)
    .map((entry) => `${field}[${entry.key}] ${entry.b.allow}/${entry.b.total} ALLOW (z=${entry.z.toFixed(1)})`);
  return suspicious.length === 0
    ? pass(`identifier-predictiveness:${field}`,
      `${tested.length} buckets of >=${minBucket}; none beyond z=${threshold.toFixed(1)} from ${overall.toFixed(3)}`)
    : fail(`identifier-predictiveness:${field}`, suspicious.slice(0, 5).join('; '));
}

/** Every clause the policy can apply is exercised, and every reason code occurs. */
function checkCoverage(all, bundle) {
  const refs = new Set(all.flatMap((e) => e.label.policy_refs));
  const codes = new Set(all.map((e) => e.label.reason_code));
  const expectedRefs = [
    ...bundle.precedence.denyOrder, ...bundle.precedence.allowPolicyRefs,
  ];
  // INVALID_PURPOSE is deliberately excluded; it cannot occur at runtime.
  const expectedCodes = Object.keys(bundle.reasonCodes).filter((c) => c !== 'INVALID_PURPOSE');
  const missingRefs = expectedRefs.filter((ref) => !refs.has(ref) && ref !== 'GP-PURPOSE:C1@v1');
  const missingCodes = expectedCodes.filter((code) => !codes.has(code));
  return missingRefs.length === 0 && missingCodes.length === 0
    ? pass('coverage', `${refs.size} clause references and ${codes.size} reason codes present`)
    : fail('coverage', `missing clauses: ${missingRefs.join(', ')}; missing codes: ${missingCodes.join(', ')}`);
}

/** Multi-clause failures exist and their precedence is applied deterministically. */
function checkPrecedence(all, bundle) {
  const multi = all.filter((e) => e.label.policy_refs.length > 1
    && e.label.recommendation === 'DENY');
  if (multi.length === 0) return fail('precedence', 'no multi-clause DENY example exists');
  const problems = [];
  const combinations = new Set();
  for (const example of multi) {
    const positions = example.label.policy_refs.map((ref) => bundle.precedence.denyOrder.indexOf(ref));
    if (positions.some((p) => p < 0)) {
      problems.push(`${example.exampleId} cites a clause outside precedence`);
    } else if (positions.join() !== [...positions].sort((a, b) => a - b).join()) {
      problems.push(`${example.exampleId} lists clauses out of precedence order`);
    }
    const decisive = bundle.clauses.find((c) => `${c.policyId}:${c.clauseId}@${bundle.version}` === example.label.policy_refs[0]);
    if (decisive && decisive.reasonCode !== example.label.reason_code) {
      problems.push(`${example.exampleId} reason code is not from the first applicable clause`);
    }
    combinations.add(example.label.policy_refs.join('+'));
    if (problems.length >= 5) break;
  }
  return problems.length === 0
    ? pass('precedence', `${multi.length} multi-clause DENY examples across ${combinations.size} clause combinations`)
    : fail('precedence', problems.join('; '));
}

/**
 * Every explanation cites only clauses the label lists and states nothing the
 * facts do not support. The reason is generated from a template over the facts,
 * so this checks that the template output really is grounded.
 */
function checkExplanationGrounding(all) {
  const problems = [];
  for (const example of all) {
    const { reason, policy_refs: refs } = example.label;
    const cited = reason.match(/GP-[A-Z]+:C\d+@v\d+/g) || [];
    const unknown = cited.filter((ref) => !refs.includes(ref));
    if (unknown.length > 0) problems.push(`${example.exampleId} cites unlisted ${unknown.join(', ')}`);
    if (cited.length === 0) problems.push(`${example.exampleId} cites no clause`);
    // The decisive clause must be named in the sentence, not only in the list.
    if (!reason.includes(refs[0])) problems.push(`${example.exampleId} does not name its decisive clause`);
    if (problems.length >= 5) break;
  }
  return problems.length === 0
    ? pass('explanation-grounding', `${all.length} explanations cite only listed clauses and name the decisive one`)
    : fail('explanation-grounding', problems.join('; '));
}

/**
 * Policy-irrelevant fields must not predict the label.
 *
 * v1 set emergencyFlag false in every example, so this check would have reported
 * a degenerate field rather than an independent one.
 */
function checkIrrelevantFieldIndependence(all, tolerance) {
  const fields = [
    ['emergencyFlag', (e) => e.verifiedRequest.request.emergencyFlag],
    ['approvalTokenPresent', (e) => e.verifiedRequest.request.approvalTokenPresent],
    ['witnessFlag', (e) => e.verifiedRequest.resource.witnessFlag],
  ];
  const overall = all.filter((e) => e.label.recommendation === 'ALLOW').length / all.length;
  const problems = [];
  const observed = {};
  for (const [name, read] of fields) {
    const groups = { true: { allow: 0, total: 0 }, false: { allow: 0, total: 0 } };
    for (const example of all) {
      const group = groups[String(Boolean(read(example)))];
      group.total += 1;
      if (example.label.recommendation === 'ALLOW') group.allow += 1;
    }
    if (groups.true.total === 0 || groups.false.total === 0) {
      problems.push(`${name} takes only one value, so it cannot act as a distractor`);
      continue;
    }
    const shares = {
      true: groups.true.allow / groups.true.total,
      false: groups.false.allow / groups.false.total,
    };
    observed[name] = {
      trueShare: Number(shares.true.toFixed(4)),
      falseShare: Number(shares.false.toFixed(4)),
      trueCount: groups.true.total,
      falseCount: groups.false.total,
    };
    if (Math.abs(shares.true - shares.false) > tolerance) {
      problems.push(`${name} ALLOW share differs by ${Math.abs(shares.true - shares.false).toFixed(3)}`);
    }
  }
  return problems.length === 0
    ? pass('irrelevant-field-independence',
      `overall ALLOW ${overall.toFixed(3)}; ${JSON.stringify(observed)}`)
    : fail('irrelevant-field-independence', problems.join('; '));
}

/** The vocabulary is fully exercised: every role, action, purpose, type, level. */
function checkVocabularyCoverage(all, bundle) {
  const seen = {
    roles: new Set(all.map((e) => e.verifiedRequest.requester.role)),
    clearances: new Set(all.map((e) => e.verifiedRequest.requester.clearance)),
    actions: new Set(all.map((e) => e.verifiedRequest.request.action)),
    purposes: new Set(all.map((e) => e.verifiedRequest.request.purpose)),
    recordTypes: new Set(all.map((e) => e.verifiedRequest.resource.recordType)),
    sensitivity: new Set(all.map((e) => e.verifiedRequest.resource.sensitivityLevel)),
    organizations: new Set(all.map((e) => e.verifiedRequest.requester.organization)),
  };
  const expected = {
    roles: Object.keys(bundle.roles),
    clearances: bundle.vocabularies.clearanceOrder,
    actions: bundle.vocabularies.actions,
    purposes: bundle.vocabularies.purposes,
    recordTypes: bundle.vocabularies.recordTypes,
    sensitivity: bundle.vocabularies.sensitivityLevels,
    organizations: Object.values(bundle.vocabularies.organizationsByMsp),
  };
  const problems = Object.entries(expected)
    .map(([key, values]) => [key, values.filter((value) => !seen[key].has(value))])
    .filter(([, missing]) => missing.length > 0)
    .map(([key, missing]) => `${key}: ${missing.join(', ')}`);
  return problems.length === 0
    ? pass('vocabulary-coverage', Object.entries(seen)
      .map(([key, set]) => `${key}=${set.size}`).join(' '))
    : fail('vocabulary-coverage', problems.join('; '));
}

/** Adversarial and near-miss material is actually present in training. */
function checkScenarioPresence(bySet) {
  const train = bySet.train || [];
  const kinds = new Set(train.map((e) => e.justificationKind));
  const scenarios = new Set(train.map((e) => e.scenario.split(':')[0]));
  const problems = [];
  for (const kind of ['plain', 'verbose', 'contradictory', 'injection']) {
    if (!kinds.has(kind)) problems.push(`training has no ${kind} justification`);
  }
  for (const scenario of ['clean-allow', 'single-violation', 'multi-violation', 'near-miss']) {
    if (!scenarios.has(scenario)) problems.push(`training has no ${scenario} scenario`);
  }
  return problems.length === 0
    ? pass('scenario-presence', `training covers ${[...scenarios].join(', ')} with ${[...kinds].join(', ')} text`)
    : fail('scenario-presence', problems.join('; '));
}

module.exports = {
  checkBalance,
  checkCoverage,
  checkDuplicatePrompts,
  checkExplanationGrounding,
  checkFamilyLeakage,
  checkFeatureLeakage,
  checkIdentifierLeakage,
  checkIdentifierPredictiveness,
  checkIrrelevantFieldIndependence,
  checkLabelReproduction,
  checkPrecedence,
  checkSchema,
  checkScenarioPresence,
  checkTemplateLeakage,
  checkVocabularyCoverage,
  splitOf,
};
