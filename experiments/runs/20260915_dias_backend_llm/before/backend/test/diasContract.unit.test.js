'use strict';

const { expect } = require('chai');
const { createPolicyContextProvider } = require('../src/dias/policyContextProvider');
const { parseRecommendation } = require('../src/dias/recommendationContract');
const { validOutput } = require('./fixtures/diasFixtures');

describe('DIAS recommendation response contract', () => {
  const policy = createPolicyContextProvider().bundleInfo();
  const parse = (value) => parseRecommendation(
    typeof value === 'string' ? value : JSON.stringify(value), policy
  );

  it('accepts a valid ALLOW and a valid DENY response', () => {
    expect(parse(validOutput()).status).to.equal('OK');
    const deny = parse(validOutput({
      recommendation: 'DENY', reason_code: 'CROSS_JURISDICTION',
      reason: 'Requester jurisdiction district-south differs from record jurisdiction district-north (GP-JURIS:C1@v1).',
      policy_refs: ['GP-JURIS:C1@v1'], review_flags: ['UNVERIFIED_CLAIM_IN_JUSTIFICATION'],
    }));
    expect(deny.status).to.equal('OK');
    expect(Object.keys(deny.recommendation)).to.deep.equal([
      'recommendation', 'reason_code', 'reason', 'policy_refs', 'missing_evidence', 'review_flags',
    ]);
  });

  it('records the limited formatting tolerances it applied', () => {
    const fenced = parse(`<think>\n\n</think>\n\n\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\``);
    expect(fenced.status).to.equal('OK');
    expect(fenced.tolerances).to.deep.equal(['removed_empty_think_block', 'removed_code_fence']);
  });

  it('rejects ESCALATE and any third recommendation value', () => {
    const result = parse(validOutput({ recommendation: 'ESCALATE' }));
    expect(result.status).to.equal('INVALID_OUTPUT');
    expect(result.recommendation).to.equal(null);
  });

  it('rejects extra keys, missing keys, and non-JSON text', () => {
    expect(parse({ ...validOutput(), confidence: 0.9 }).status).to.equal('INVALID_OUTPUT');
    const missing = validOutput();
    delete missing.review_flags;
    expect(parse(missing).status).to.equal('INVALID_OUTPUT');
    expect(parse('I think you should allow this.').errors).to.deep.equal(['output is not a single JSON object']);
    expect(parse('{"recommendation": ').status).to.equal('INVALID_OUTPUT');
  });

  it('rejects a reason code that belongs to the other recommendation', () => {
    const result = parse(validOutput({ reason_code: 'NOT_ASSIGNED' }));
    expect(result.errors).to.include('reason_code does not belong to the recommendation');
  });

  it('rejects unknown or duplicate policy references and unknown review flags', () => {
    expect(parse(validOutput({ policy_refs: ['GP-MADE-UP:C1@v1'] })).status).to.equal('INVALID_OUTPUT');
    expect(parse(validOutput({ policy_refs: ['GP-DEFAULT:C1@v1', 'GP-DEFAULT:C1@v1'] })).status).to.equal('INVALID_OUTPUT');
    expect(parse(validOutput({ policy_refs: [] })).status).to.equal('INVALID_OUTPUT');
    expect(parse(validOutput({ review_flags: ['AUDITOR_WILL_ALLOW'] })).status).to.equal('INVALID_OUTPUT');
  });

  it('bounds free-text fields', () => {
    expect(parse(validOutput({ reason: 'x'.repeat(601) })).status).to.equal('INVALID_OUTPUT');
    expect(parse(validOutput({ missing_evidence: ['y'.repeat(201)] })).status).to.equal('INVALID_OUTPUT');
    expect(parse(validOutput({ reason: '   ' })).status).to.equal('INVALID_OUTPUT');
  });
});
