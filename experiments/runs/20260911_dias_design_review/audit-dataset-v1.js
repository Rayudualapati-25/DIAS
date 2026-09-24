'use strict';

// Read-only audit of DIAS data-v1 for the design review: label provenance,
// rule co-violations, shortcut and leakage signals, and a stratified sample for
// manual label review.
// Usage (repository root): node audit-dataset-v1.js <repo-root> <output-dir>

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [ROOT, OUT_DIR] = process.argv.slice(2);
if (!ROOT || !OUT_DIR) throw new Error('usage: node audit-dataset-v1.js <repo-root> <output-dir>');

const DATA_DIR = path.join(ROOT, 'experiments/dias-finetuning/data-v1');
const POLICY_DIR = path.join(ROOT, 'chaincode/crimerecords/lib/policy');
const { evaluate, MSP_DEPARTMENT } = require(path.join(POLICY_DIR, 'policyEngine'));
const {
  RBAC, ASSIGNMENT_EXEMPT, JUVENILE_ALLOWED, PURPOSES, CLEARANCE_RANK, RECORD_TYPES,
} = require(path.join(POLICY_DIR, 'policyV1'));
const { RANK_TABLE } = require(path.join(POLICY_DIR, 'authority'));

const SPLITS = ['train', 'valid', 'test'];
const VICTIM_BLOCKED_ROLES = ['lab-analyst', 'lab-director'];
const RULE_REASON = {
  R1_CRED_NOT_ACTIVE: 'CRED_NOT_ACTIVE',
  R2_INVALID_PURPOSE: 'INVALID_PURPOSE',
  R3_RBAC_NO_PERMISSION: 'RBAC_NO_PERMISSION',
  R4_SEALED_RECORD: 'SEALED_RECORD',
  R5_JUVENILE_PROTECTED: 'JUVENILE_PROTECTED',
  R5b_VICTIM_DATA_NOT_NECESSARY: 'VICTIM_DATA_NOT_NECESSARY',
  R6_CROSS_JURISDICTION: 'CROSS_JURISDICTION',
  R7_NOT_ASSIGNED: 'NOT_ASSIGNED',
  R8_INSUFFICIENT_CLEARANCE: 'INSUFFICIENT_CLEARANCE',
};
const KEYWORDS = {
  sealed: /\bseal/i,
  juvenile: /juvenile|\bminor\b|\bchild/i,
  victim: /victim/i,
  assignment: /assign/i,
  jurisdiction: /jurisdiction|district/i,
  clearance: /clearance|classified|secret/i,
  credential: /credential|suspend|revok|inactive/i,
  urgency: /emergency|urgent|immediately|asap/i,
  identityClaim: /\bI am\b|\bI'm\b|\bmy role\b|\bas (a|an|the) [a-z-]+ I\b/i,
  injection: /ignore|override|bypass|previous instructions|system prompt|developer/i,
};

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const countBy = (items, keyOf) => items.reduce(
  (counts, item) => ({ ...counts, [keyOf(item)]: (counts[keyOf(item)] || 0) + 1 }), {}
);
const assignedToCase = (subject, caseId) => String(subject.caseAssignments || '')
  .split(/[,|]/).map((value) => value.trim()).includes(caseId);

// Every rule predicate evaluated independently; the engine stops at the first.
function violatedRules(subject, record, action, purpose) {
  const roleDefinition = RANK_TABLE[subject.role];
  const ownsRole = Boolean(roleDefinition) && MSP_DEPARTMENT[subject.mspId] === roleDefinition.department;
  const permittedTypes = ownsRole ? (RBAC[subject.role] || {})[action] : undefined;
  const checks = [
    ['R1_CRED_NOT_ACTIVE', subject.credentialStatus !== 'active'],
    ['R2_INVALID_PURPOSE', !PURPOSES.includes(purpose)],
    ['R3_RBAC_NO_PERMISSION', !permittedTypes || !permittedTypes.includes(record.recordType)],
    ['R4_SEALED_RECORD', Boolean(record.sealed) && subject.mspId !== 'CourtMSP'],
    ['R5_JUVENILE_PROTECTED', Boolean(record.juvenileFlag) && !JUVENILE_ALLOWED.includes(subject.role)],
    ['R5b_VICTIM_DATA_NOT_NECESSARY', Boolean(record.victimProtectionFlag) && VICTIM_BLOCKED_ROLES.includes(subject.role)],
    ['R6_CROSS_JURISDICTION', subject.jurisdiction !== record.jurisdiction],
    ['R7_NOT_ASSIGNED', !ASSIGNMENT_EXEMPT.includes(subject.role) && !assignedToCase(subject, record.caseId)],
    ['R8_INSUFFICIENT_CLEARANCE', (CLEARANCE_RANK[subject.clearance] ?? -1) < (CLEARANCE_RANK[record.sensitivityLevel] ?? 2)],
  ];
  return checks.filter(([, violated]) => violated).map(([rule]) => rule);
}

function analyse(row) {
  const { subject, record, requestContext, query } = row.input;
  const matches = (result) => result.decision === row.expected.decision
    && result.reasonCode === row.expected.reasonCode;
  const violations = violatedRules(subject, record, row.expected.action, row.expected.purpose);
  return {
    row,
    labelFromCommittedInputs: matches(evaluate(subject, record, requestContext.action, { purpose: requestContext.purpose })),
    labelFromExpectedInputs: matches(evaluate(subject, record, row.expected.action, { purpose: row.expected.purpose })),
    committedDiffersFromExpected: requestContext.action !== row.expected.action
      || requestContext.purpose !== row.expected.purpose,
    violations,
    firstViolationMatchesLabel: row.expected.reasonCode === 'POLICY_SATISFIED'
      ? violations.length === 0
      : RULE_REASON[violations[0]] === row.expected.reasonCode,
    governedKey: sha(JSON.stringify({
      subject: [subject.mspId, subject.organization, subject.role, subject.rank, subject.jurisdiction,
        subject.clearance, subject.credentialStatus, assignedToCase(subject, record.caseId)],
      record: [record.recordType, record.sensitivityLevel, record.jurisdiction, record.owningAgency,
        Boolean(record.sealed), Boolean(record.juvenileFlag), Boolean(record.witnessFlag),
        Boolean(record.victimProtectionFlag)],
      request: [row.expected.action, row.expected.purpose, Boolean(requestContext.emergencyFlag),
        Boolean(requestContext.approvalTokenPresent)],
    })),
    template: String(query)
      .replace(/\b[A-Z]+(?:-[A-Z]+)*-(?:TRAIN|VALID|TEST)-\d+\b/g, '<ID>')
      .replace(/\b[a-z-]+\.(?:train|valid|test)\.\d+\b/g, '<USER>')
      .replace(new RegExp(`\\b(${[...PURPOSES, ...RECORD_TYPES, ...Object.keys(RANK_TABLE)].join('|')})\\b`, 'g'), '<TERM>')
      .replace(/\d+/g, '<N>'),
  };
}

function splitReport(split, analysed) {
  const reasons = [...new Set(analysed.map((a) => a.row.expected.reasonCode))].sort();
  const perReason = Object.fromEntries(reasons.map((reason) => {
    const group = analysed.filter((a) => a.row.expected.reasonCode === reason);
    const ids = group.map((a) => Number((a.row.id.match(/(\d+)$/) || [])[1])).filter(Number.isFinite).sort((x, y) => x - y);
    const patterns = countBy(group, (a) => a.violations.join('+') || 'none');
    return [reason, {
      examples: group.length,
      adversarial: group.filter((a) => a.row.adversarial).length,
      distinctRoles: new Set(group.map((a) => a.row.input.subject.role)).size,
      violatedRuleCount: countBy(group, (a) => (a.violations.length >= 3 ? '3+' : String(a.violations.length))),
      topViolationPatterns: Object.entries(patterns).sort((x, y) => y[1] - x[1]).slice(0, 4),
      committedActionOrPurposeDiffers: group.filter((a) => a.committedDiffersFromExpected).length,
      emergencyFlagTrue: group.filter((a) => a.row.input.requestContext.emergencyFlag).length,
      approvalTokenTrue: group.filter((a) => a.row.input.requestContext.approvalTokenPresent).length,
      recordIdNumberRange: ids.length ? [ids[0], ids[ids.length - 1]] : null,
      queryKeywordShare: Object.fromEntries(Object.entries(KEYWORDS).map(([name, pattern]) => [
        name, Number((group.filter((a) => pattern.test(a.row.input.query)).length / group.length).toFixed(2)),
      ])),
    }];
  }));
  const allowRows = analysed.filter((a) => a.row.expected.decision === 'allow');
  return {
    examples: analysed.length,
    labelsReproducedFromExpectedInputs: analysed.filter((a) => a.labelFromExpectedInputs).length,
    labelsReproducedFromCommittedInputs: analysed.filter((a) => a.labelFromCommittedInputs).length,
    firstViolationMatchesLabel: analysed.filter((a) => a.firstViolationMatchesLabel).length,
    multiRuleViolations: analysed.filter((a) => a.violations.length >= 2).length,
    usernameContainsRole: analysed.filter((a) => String(a.row.input.subject.username).includes(a.row.input.subject.role)).length,
    usernameContainsSplitName: analysed.filter((a) => String(a.row.input.subject.username).includes(`.${split}.`)).length,
    distinctQueryTemplates: new Set(analysed.map((a) => a.template)).size,
    allowPurposeByDepartment: countBy(allowRows, (a) => `${a.row.input.subject.organization}:${a.row.expected.purpose}`),
    invalidPurposeValues: {
      committed: countBy(analysed.filter((a) => a.row.expected.reasonCode === 'INVALID_PURPOSE'), (a) => String(a.row.input.requestContext.purpose)),
      expected: countBy(analysed.filter((a) => a.row.expected.reasonCode === 'INVALID_PURPOSE'), (a) => String(a.row.expected.purpose)),
    },
    perReason,
  };
}

function diversePick(candidates, count) {
  const byRole = candidates.reduce((acc, row) => (
    acc.length < count && !acc.some((picked) => picked.input.subject.role === row.input.subject.role)
      ? [...acc, row] : acc
  ), []);
  const needsAdversarial = !byRole.some((row) => row.adversarial);
  const adversarial = needsAdversarial
    ? candidates.filter((row) => row.adversarial && !byRole.includes(row)).slice(0, 1) : [];
  const base = [...byRole.slice(0, count - adversarial.length), ...adversarial];
  return [...base, ...candidates.filter((row) => !base.includes(row)).slice(0, count - base.length)];
}

function reviewSample(rowsBySplit) {
  const reasons = [...new Set(rowsBySplit.train.map((row) => row.expected.reasonCode))].sort();
  return reasons.flatMap((reason) => [['train', 4], ['test', 2]].flatMap(([split, count]) => diversePick(
    rowsBySplit[split]
      .filter((row) => row.expected.reasonCode === reason)
      .sort((a, b) => sha(`${split}:${a.id}`).localeCompare(sha(`${split}:${b.id}`))),
    count
  ).map((row) => ({ split, row }))));
}

function toCsv(sample) {
  const header = ['sample', 'split', 'id', 'adversarial', 'all_violated_rules', 'label_decision', 'label_reason',
    'role', 'msp', 'clearance', 'credential_status', 'user_district', 'record_district', 'assigned_to_case',
    'record_type', 'sensitivity', 'sealed', 'juvenile', 'victim_protected', 'witness', 'action', 'purpose',
    'emergency_flag', 'approval_token', 'user_query', 'reviewer_agrees_yes_no', 'reviewer_correct_label', 'reviewer_notes'];
  const rows = sample.map(({ split, row }, index) => {
    const { subject, record, requestContext, query } = row.input;
    return [index + 1, split, row.id, row.adversarial,
      violatedRules(subject, record, row.expected.action, row.expected.purpose).join(' + ') || 'none',
      row.expected.decision, row.expected.reasonCode, subject.role, subject.mspId, subject.clearance,
      subject.credentialStatus, subject.jurisdiction, record.jurisdiction, assignedToCase(subject, record.caseId),
      record.recordType, record.sensitivityLevel, Boolean(record.sealed), Boolean(record.juvenileFlag),
      Boolean(record.victimProtectionFlag), Boolean(record.witnessFlag), row.expected.action, row.expected.purpose,
      Boolean(requestContext.emergencyFlag), Boolean(requestContext.approvalTokenPresent), query, '', '', ''];
  });
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `${[header, ...rows].map((cells) => cells.map(cell).join(',')).join('\n')}\n`;
}

function main() {
  const rowsBySplit = Object.fromEntries(SPLITS.map((split) => [split, readJsonl(path.join(DATA_DIR, `${split}.cases.jsonl`))]));
  const analysedBySplit = Object.fromEntries(SPLITS.map((split) => [split, rowsBySplit[split].map(analyse)]));
  const keysBySplit = Object.fromEntries(SPLITS.map((split) => [split, new Set(analysedBySplit[split].map((a) => a.governedKey))]));
  const templatesBySplit = Object.fromEntries(SPLITS.map((split) => [split, new Set(analysedBySplit[split].map((a) => a.template))]));
  const all = SPLITS.flatMap((split) => analysedBySplit[split]);
  const reasonsByKey = all.reduce((acc, a) => ({
    ...acc, [a.governedKey]: [...new Set([...(acc[a.governedKey] || []), a.row.expected.reasonCode])],
  }), {});
  const overlap = (a, b, sets) => [...sets[a]].filter((value) => sets[b].has(value)).length;
  const sample = reviewSample(rowsBySplit);

  const report = {
    auditedAtUtc: new Date().toISOString(),
    dataset: 'experiments/dias-finetuning/data-v1',
    method: 'labels re-evaluated with chaincode/crimerecords/lib/policy/policyEngine.js; rule predicates evaluated independently to find co-violations',
    splits: Object.fromEntries(SPLITS.map((split) => [split, splitReport(split, analysedBySplit[split])])),
    crossSplit: {
      governedFeatureOverlap: { trainTest: overlap('train', 'test', keysBySplit), trainValid: overlap('train', 'valid', keysBySplit) },
      queryTemplateOverlap: { trainTest: overlap('train', 'test', templatesBySplit), trainValid: overlap('train', 'valid', templatesBySplit) },
      governedFeatureSetsWithConflictingLabels: Object.values(reasonsByKey).filter((reasons) => reasons.length > 1).length,
    },
    adversarialQueryExamples: analysedBySplit.train.filter((a) => a.row.adversarial)
      .sort((a, b) => sha(a.row.id).localeCompare(sha(b.row.id))).slice(0, 4)
      .map((a) => ({ id: a.row.id, label: a.row.expected.reasonCode, query: a.row.input.query })),
    reviewSample: { file: 'dataset_review_sample.csv', rows: sample.length, design: '4 train + 2 test per reason code, role-diverse, at least one adversarial per group when available' },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'dataset_audit.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'dataset_review_sample.csv'), toCsv(sample));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
