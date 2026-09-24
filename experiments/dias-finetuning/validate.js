'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { evaluate } = require('../../chaincode/crimerecords/lib/policy/policyEngine');
const {
  MODEL_VERSION,
  RECOMMENDATION_REASONS,
} = require('./generate');

const DEFAULT_DATA_DIR = path.join(__dirname, 'data-v1');
const EXPECTED_OUTPUT_KEYS = Object.freeze([
  'action', 'decision', 'modelVersion', 'policyVersion', 'purpose', 'reasonCode',
]);
const SUBJECT_FIELDS = Object.freeze([
  'enrollmentId', 'username', 'mspId', 'organization', 'role', 'rank', 'station',
  'jurisdiction', 'clearance', 'credentialStatus', 'caseAssignments',
]);
const RECORD_FIELDS = Object.freeze([
  'recordId', 'caseId', 'recordType', 'sensitivityLevel', 'jurisdiction',
  'owningAgency', 'owningStation', 'sealed', 'juvenileFlag', 'witnessFlag',
  'victimProtectionFlag',
]);
const REQUEST_FIELDS = Object.freeze([
  'action', 'purpose', 'emergencyFlag', 'approvalTokenPresent',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (_error) {
      throw new Error(`${file}:${index + 1} is not valid JSON`);
    }
  });
}

function sameKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).sort().join('\0') === [...keys].sort().join('\0');
}

function requireFields(object, fields, location) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(object || {}, field)) {
      throw new Error(`${location} is missing ${field}`);
    }
  }
}

function addUnique(seen, value, label) {
  if (seen.has(value)) throw new Error(`${label} crosses a split or is duplicated: ${value}`);
  seen.add(value);
}

function validateDataset(dataDir = DEFAULT_DATA_DIR, options = {}) {
  const manifestPath = path.join(dataDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const reasonQuotas = options.perReason
    ? Object.fromEntries(['train', 'valid', 'test'].map((split) => [split,
      Object.fromEntries(RECOMMENDATION_REASONS.map(
        (reason) => [reason, options.perReason[split]]
      )),
    ]))
    : Object.fromEntries(Object.entries(manifest.splits).map(
      ([split, splitSummary]) => [split, splitSummary.byReason]
    ));
  const seen = {
    id: new Set(), username: new Set(), caseId: new Set(), fingerprint: new Set(),
  };
  const summary = { valid: true, datasetVersion: manifest.datasetVersion, splits: {} };

  for (const split of ['train', 'valid', 'test']) {
    const casesFile = path.join(dataDir, `${split}.cases.jsonl`);
    const chatFile = path.join(dataDir, `${split}.jsonl`);
    const rows = readJsonLines(casesFile);
    const chats = readJsonLines(chatFile);
    const expectedCount = Object.values(reasonQuotas[split]).reduce(
      (total, count) => total + count, 0
    );
    if (rows.length !== expectedCount || chats.length !== expectedCount) {
      throw new Error(`${split} count mismatch: cases=${rows.length}, chat=${chats.length}, expected=${expectedCount}`);
    }
    const byReason = Object.fromEntries(RECOMMENDATION_REASONS.map((reason) => [reason, 0]));
    rows.forEach((row, index) => {
      requireFields(row.input.subject, SUBJECT_FIELDS, `${split}[${index}].subject`);
      requireFields(row.input.record, RECORD_FIELDS, `${split}[${index}].record`);
      requireFields(row.input.requestContext, REQUEST_FIELDS, `${split}[${index}].requestContext`);
      if (!sameKeys(row.expected, EXPECTED_OUTPUT_KEYS)) {
        throw new Error(`${split}[${index}] has an incompatible model output schema`);
      }
      if (row.expected.modelVersion !== MODEL_VERSION) {
        throw new Error(`${split}[${index}] has an unexpected modelVersion`);
      }
      const policyResult = evaluate(
        row.input.subject,
        row.input.record,
        row.input.requestContext.action,
        { purpose: row.input.requestContext.purpose }
      );
      if (policyResult.reasonCode !== row.expected.reasonCode
          || policyResult.decision !== row.expected.decision) {
        throw new Error(`${split}[${index}] label does not match the declared offline oracle`);
      }
      byReason[row.expected.reasonCode] += 1;
      addUnique(seen.id, row.id, 'record ID');
      addUnique(seen.username, row.input.subject.username, 'username');
      addUnique(seen.caseId, row.input.record.caseId, 'case ID');
      addUnique(seen.fingerprint, row.structuralFingerprint, 'structural fingerprint');

      const messages = chats[index].messages;
      if (!Array.isArray(messages) || messages.length !== 3
          || messages.map((message) => message.role).join(',') !== 'system,user,assistant') {
        throw new Error(`${split}[${index}] is not a three-message chat example`);
      }
      if (messages[2].content !== JSON.stringify(row.expected)) {
        throw new Error(`${split}[${index}] assistant target differs from the raw case`);
      }
      if (!messages[1].content.includes(JSON.stringify(row.input.subject))
          || !messages[1].content.includes(JSON.stringify(row.input.record))) {
        throw new Error(`${split}[${index}] prompt omits governed input fields`);
      }
    });
    for (const reason of RECOMMENDATION_REASONS) {
      if (byReason[reason] !== reasonQuotas[split][reason]) {
        throw new Error(`${split}/${reason} count is ${byReason[reason]}, expected ${reasonQuotas[split][reason]}`);
      }
    }
    const adversarialExamples = rows.filter((row) => row.adversarial).length;
    if (adversarialExamples / rows.length < 0.20) {
      throw new Error(`${split} adversarial share is below 20 percent`);
    }
    summary.splits[split] = { examples: rows.length, adversarialExamples, byReason };
  }

  const workflows = readJsonLines(path.join(dataDir, 'workflow-evaluation.jsonl'));
  if (workflows.length < 9 || workflows.some(
    (workflow) => workflow.datasetRole !== 'workflow-evaluation-only'
  )) {
    throw new Error('workflow evaluation fixtures are missing or mixed with training data');
  }
  const nearMissWorkflow = workflows.find(
    (workflow) => workflow.sequenceId === 'exact-repeat-and-one-field-near-misses'
  );
  const changedDimensions = new Set(
    nearMissWorkflow?.steps.map((step) => step.changedDimension).filter(Boolean)
  );
  if (changedDimensions.size !== 21) {
    throw new Error(`workflow near-miss coverage is ${changedDimensions.size}, expected 21`);
  }
  summary.workflowEvaluationSequences = workflows.length;
  summary.oneFieldNearMissDimensions = changedDimensions.size;

  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const file = path.join(dataDir, name);
    const digest = sha256(fs.readFileSync(file));
    if (digest !== artifact.sha256) throw new Error(`${name} does not match its manifest hash`);
  }
  return summary;
}

function parseArguments(argv) {
  let dataDir = DEFAULT_DATA_DIR;
  let report = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data') dataDir = path.resolve(argv[++index]);
    else if (argv[index] === '--report') report = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { dataDir, report };
}

if (require.main === module) {
  const { dataDir, report } = parseArguments(process.argv.slice(2));
  const result = validateDataset(dataDir);
  if (report) {
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = { validateDataset };
