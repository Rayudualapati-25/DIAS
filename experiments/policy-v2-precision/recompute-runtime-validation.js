'use strict';

/** Re-score retained model rows using the exact current runtime acceptance rule. */
const fs = require('fs');
const reasonDecisions = require('../../chaincode/crimerecords/lib/policy/reasonDecisions');
const { score } = require('./evaluate');

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node recompute-runtime-validation.js INPUT OUTPUT');
if (fs.existsSync(output)) throw new Error(`output exists: ${output}`);
const retained = JSON.parse(fs.readFileSync(input));
const rows = retained.rows.map((row) => {
  const selfConsistent = row.prediction
    && reasonDecisions[row.prediction.reasonCode] === row.prediction.decision;
  if (selfConsistent) return row;
  return {
    ...row,
    valid: false,
    guardDisagreement: false,
    guardedDecision: null,
    runtimeRejection: 'reasonCode is inconsistent with decision',
  };
});
const result = {
  source: input,
  correction: 'Exact runtime validation rejects contradictory decision/reason pairs.',
  metrics: score(rows),
  rejectedContradictions: rows.filter((row) => row.runtimeRejection).map((row) => row.id),
};
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result.metrics));
