'use strict';

/**
 * Template explanation writer — no AI involved.
 *
 * Two jobs:
 *  1. Fallback. If Ollama is off, users still get a readable sentence.
 *  2. Baseline. The experiment compares the LLM against this, so it has to be
 *     genuinely good, not a straw man.
 *
 * It is fully deterministic: same artifact in, same sentence out.
 */

// Plain-English sentence for each reason the policy engine can return.
const REASON_SENTENCE = Object.freeze({
  POLICY_SATISFIED:
    'every policy check passed for this role, purpose and record sensitivity',
  CRED_NOT_ACTIVE:
    'the requester credential status is not active, so the request cannot proceed',
  INVALID_PURPOSE:
    'no valid declared purpose was attached to the request',
  RBAC_NO_PERMISSION:
    'this role holds no permission for that action on that record type',
  SEALED_RECORD:
    'the record carries sealed status, so a court authority must decide access',
  JUVENILE_PROTECTED:
    'the record is juvenile-protected and the requester role is not in the permitted exception',
  VICTIM_DATA_NOT_NECESSARY:
    'a forensic laboratory role requested a record containing victim-protected raw data',
  CROSS_JURISDICTION:
    'the requester jurisdiction differs from the record jurisdiction',
  NOT_ASSIGNED:
    'the requester has no case assignment covering this record',
  INSUFFICIENT_CLEARANCE:
    'the requester clearance sits below the record sensitivity level',
  MODEL_POLICY_DISAGREEMENT:
    'the model decision or reason code differs from the deterministic policy result',
  MODEL_INPUT_DISAGREEMENT:
    'the model-interpreted action or purpose differs from the committed request',
});

const OUTCOME = Object.freeze({
  allow: 'Access was allowed',
  deny: 'Access was denied',
  escalate: 'Access was escalated for senior review',
});

/**
 * Turn attribute names the chaincode uses (subject.clearance) into readable
 * words (requester clearance). Naming the attributes matters: the paper's
 * quality metric checks whether the text actually mentions what decided it.
 */
const ATTRIBUTE_WORDS = Object.freeze({
  'subject.role': 'requester role',
  'subject.rank': 'requester rank',
  'subject.station': 'requester station',
  'subject.jurisdiction': 'requester jurisdiction',
  'subject.clearance': 'requester clearance',
  'subject.credentialStatus': 'requester credential status',
  'subject.caseAssignments': 'case assignment',
  'subject.mspId': 'requester organization',
  'object.recordType': 'record type',
  'object.sensitivityLevel': 'record sensitivity level',
  'object.juvenileFlag': 'juvenile flag',
  'object.victimProtectionFlag': 'victim-protection flag',
  'object.witnessFlag': 'witness flag',
  'object.sealed': 'sealed status',
  'object.jurisdiction': 'record jurisdiction',
  'object.caseId': 'case identifier',
  'env.purpose': 'purpose',
  'env.emergencyFlag': 'emergency flag',
  'env.approvalToken': 'approval token',
  action: 'action',
  'model.action': 'model-interpreted action',
  'model.purpose': 'model-interpreted purpose',
  'model.decision': 'model decision',
  'model.reasonCode': 'model reason code',
  'policy.expectedDecision': 'deterministic policy decision',
  'policy.expectedReasonCode': 'deterministic policy reason code',
  'request.action': 'committed action',
  'request.purpose': 'committed purpose',
});

function readable(attribute) {
  return ATTRIBUTE_WORDS[attribute] || attribute.replace(/^[a-z]+\./, '').replace(/([A-Z])/g, ' $1').toLowerCase();
}

function joinWords(items) {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Build the explanation sentence from a committed artifact.
 * @param {object} explanation stored artifact (decision, reasonCode, decisiveAttributes, counterfactual, policyVersion)
 * @param {object} context     { subject, environment, record } for concrete values
 */
function render(explanation, context = {}) {
  const outcome = OUTCOME[explanation.decision] || `Decision '${explanation.decision}' was recorded`;
  const because = REASON_SENTENCE[explanation.reasonCode] || `the policy returned ${explanation.reasonCode}`;

  const attributes = (explanation.decisiveAttributes || []).map(readable);
  const decisive = attributes.length
    ? ` The attributes that decided it were ${joinWords(attributes)}.`
    : '';

  const subject = context.subject || {};
  const record = context.record || {};
  const environment = context.environment || {};
  const facts = [
    subject.role && `requester role ${subject.role}`,
    subject.clearance && `requester clearance ${subject.clearance}`,
    record.recordType && `record type ${record.recordType}`,
    record.sensitivityLevel && `record sensitivity level ${record.sensitivityLevel}`,
    environment.purpose && `purpose ${environment.purpose}`,
  ].filter(Boolean);
  const detail = facts.length ? ` Context: ${joinWords(facts)}.` : '';

  const counterfactual = explanation.counterfactual
    ? ` What would change the outcome: ${explanation.counterfactual}.`
    : '';

  const version = explanation.policyVersion
    ? ` Evaluated under policy ${explanation.policyVersion}.`
    : '';

  return `${outcome} because ${because}.${decisive}${detail}${counterfactual}${version}`;
}

module.exports = { render, readable, ATTRIBUTE_WORDS, REASON_SENTENCE };
