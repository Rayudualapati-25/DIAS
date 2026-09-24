'use strict';

// Re-score retained evaluation runs under the current output contract, in which the
// decision is derived from the reason code rather than taken from the model.
// The raw model outputs are unchanged and no inference is re-run, so this is an
// ablation of the output contract, not a new experiment arm.

const fs = require('fs');
const path = require('path');
const { materializeDecision, REASON_DECISION } = require('./policy_prompts');
const { summarise, schemaProblems } = require('./evaluate');

function equalSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');
}

function rescore(runPath, dataPath) {
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const trusted = new Map();
  for (const line of fs.readFileSync(dataPath, 'utf8').trim().split('\n')) {
    const example = JSON.parse(line);
    trusted.set(example.metadata.id, example.metadata.trusted);
  }

  const rows = run.rows.map((row) => {
    const classification = row.classification;
    const problems = schemaProblems(classification);
    let prediction = null;
    if (problems.length === 0) {
      try {
        prediction = materializeDecision(classification, trusted.get(row.id));
      } catch (error) {
        problems.push(`materialization failed: ${error.message}`);
      }
    }
    const expected = row.expected;
    return {
      ...row,
      prediction,
      schemaProblems: problems,
      decisionDisagreement: Boolean(classification
        && REASON_DECISION[classification.reasonCode]
        && REASON_DECISION[classification.reasonCode] !== classification.decision),
      decisionCorrect: prediction?.decision === expected.decision,
      reasonCorrect: prediction?.reasonCode === expected.reasonCode,
      jointCorrect: prediction?.decision === expected.decision
        && prediction?.reasonCode === expected.reasonCode,
      attributesCorrect: equalSet(prediction?.decisiveAttributes, expected.decisiveAttributes),
      actionCorrect: prediction?.parsedRequest?.action === expected.parsedRequest.action,
      purposeCorrect: prediction?.parsedRequest?.purpose === expected.parsedRequest.purpose,
    };
  });

  return {
    ...run,
    rescoredAtUtc: new Date().toISOString(),
    rescoreNote: 'decision derived from reasonCode; raw model outputs unchanged',
    metrics: summarise(rows),
    rows,
  };
}

if (require.main === module) {
  const [, , dataPath, ...runPaths] = process.argv;
  for (const runPath of runPaths) {
    const output = rescore(runPath, dataPath);
    const target = runPath.replace(/\.json$/, '.rescored.json');
    fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);
    process.stdout.write(`${path.basename(target)}\n`);
  }
}

module.exports = { rescore };
