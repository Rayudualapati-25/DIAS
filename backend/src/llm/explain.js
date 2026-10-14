'use strict';

/** The explainable-AI module. */

const crypto = require('crypto');
const ollama = require('./ollama');
const template = require('./template');

// Bump this if the prompt wording changes, so cached text is not reused.
const PROMPT_VERSION = 'v4';

const SYSTEM_PROMPT = [
  'You explain access-control decisions for police record systems to the officer who made the request.',
  'You never make or change the decision. It has already been decided and recorded.',
  'The three possible decisions mean exactly this:',
  '"allow" means access was granted;',
  '"deny" means access was refused and this request will not proceed;',
  '"escalate" means access is NOT refused but is held for an authorized reviewer:',
  'CourtMSP reviews sealed-record escalations and AuditMSP reviews model/input disagreements;',
  'never describe an escalated decision as final,',
  'permanent, or impossible to change.',
  'Write 2 to 3 plain sentences. No lists, no headings, no preamble.',
  'You must name every attribute given under DECISIVE ATTRIBUTES, using those words.',
  'You must NOT blame anything that is not in DECISIVE ATTRIBUTES — for example do',
  'not say clearance was the problem unless clearance is listed there.',
  'If WHAT WOULD CHANGE IT is given, you must include it in your answer.',
  'Use only the facts provided. Never invent names, case numbers, dates, or a record type.',
  'Refer to the protected item only as "the case file" because its record type was not supplied.',
].join(' ');

/** Build the prompt. */
function buildPrompt(decisionEvent) {
  const e = decisionEvent.explanation || {};
  const s = decisionEvent.subject || {};
  const env = decisionEvent.environment || {};

  const lines = [
    `DECISION: ${e.decision}`,
    `REASON CODE: ${e.reasonCode}`,
    `DECISIVE ATTRIBUTES: ${(e.decisiveAttributes || []).map(template.readable).join(', ') || 'none recorded'}`,
    `REQUESTER: role ${s.role || 'unknown'}, clearance ${s.clearance || 'unknown'}, jurisdiction ${s.jurisdiction || 'unknown'}`,
    `ACTION REQUESTED: ${decisionEvent.action}`,
    `PURPOSE: ${env.purpose || 'not stated'}`,
    `POLICY VERSION: ${e.policyVersion}`,
  ];
  if (e.counterfactual) lines.push(`WHAT WOULD CHANGE IT: ${e.counterfactual}`);

  lines.push('', 'Explain this decision to the requester in 2 to 3 sentences.');
  return lines.join('\n');
}

/** Check the model's answer is actually about this decision. */
function validate(text, decisionEvent) {
  const problems = [];
  const warnings = [];
  const lower = text.toLowerCase();
  const textWithoutKnownIds = lower
    .replaceAll(String(decisionEvent.recordId || '').toLowerCase(), '')
    .replaceAll(String(decisionEvent.caseId || '').toLowerCase(), '');
  const decision = decisionEvent.explanation.decision;

  // 1. It must not claim a different outcome than the one on the ledger.
  const OTHERS = { allow: ['denied', 'escalated'], deny: ['allowed', 'granted'], escalate: ['allowed', 'granted', 'denied'] };
  for (const wrong of OTHERS[decision] || []) {
    if (lower.includes(wrong)) problems.push(`states "${wrong}" but the decision was ${decision}`);
  }

  // The prompt deliberately omits record type. Reject guesses rather than showing an invented type (a real
  // failure once called an FIR a case diary).
  const inventedRecordType = /\b(fir|case diary|evidence|forensic report|witness statement|chargesheet|court order)\b/i
    .exec(textWithoutKnownIds);
  if (inventedRecordType) {
    problems.push(`invents unsupported record type "${inventedRecordType[1]}"`);
  }

  // 1b. An escalated request is pending review, not settled.
  if (decision === 'escalate' &&
      /\b(is final|cannot be changed|cannot be overturned|permanently|no appeal|irreversible)\b/i.test(lower)) {
    problems.push('describes an escalated decision as final');
  }

  // 1c. Misattribution: the model must not blame a factor that did not decide this request.
  const BLAME_TOPICS = [
    { words: /\bclearance\b/i, attribute: 'subject.clearance' },
    { words: /\bjurisdiction\b/i, attributes: ['subject.jurisdiction', 'object.jurisdiction'] },
    { words: /\bjuvenile\b/i, attribute: 'object.juvenileFlag' },
    { words: /\bsealed\b/i, attribute: 'object.sealed' },
    { words: /\b(credential|revoked|suspended)\b/i, attribute: 'subject.credentialStatus' },
    { words: /\b(assignment|assigned to)\b/i, attributes: ['subject.caseAssignments', 'object.caseId'] },
  ];
  const decisive = new Set(decisionEvent.explanation.decisiveAttributes || []);
  for (const topic of BLAME_TOPICS) {
    const licensed = (topic.attributes || [topic.attribute]).some((a) => decisive.has(a));
    if (!licensed && topic.words.test(text)) {
      problems.push(`blames "${topic.words.source.replace(/\\b|[()]/g, '')}" which did not decide this request`);
    }
  }

  // 1d. The counterfactual is the actionable part, so note when it is dropped.
  if (decisionEvent.explanation.counterfactual &&
      !/\bwould\b|\bif\b|\bupgrade|\bonce\b/i.test(text)) {
    warnings.push('omits the counterfactual');
  }

  // 2. Length sanity — too short says nothing, too long is rambling.
  if (text.length < 40) problems.push('too short to be an explanation');
  if (text.length > 1200) problems.push('too long');

  // 3. No assistant scaffolding leaking through.
  if (/^(sure|certainly|of course|here('s| is))\b/i.test(text)) problems.push('starts with filler');
  if (/as an ai|language model/i.test(lower)) problems.push('mentions being an AI');

  // 4. No invented identifiers.
  const invented = (text.match(/\b[A-Z]{2,}-[A-Z0-9-]{3,}\b/g) || []).filter(
    (token) => token !== decisionEvent.recordId && token !== decisionEvent.caseId
  );
  if (invented.length) problems.push(`invented identifier(s): ${invented.join(', ')}`);

  return { ok: problems.length === 0, problems, warnings };
}

function hash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Produce the plain-language explanation for one committed decision. */
async function explainDecision(decisionEvent, store) {
  const context = {
    subject: decisionEvent.subject,
    environment: decisionEvent.environment,
    record: { recordType: decisionEvent.recordType, sensitivityLevel: decisionEvent.sensitivityLevel },
  };
  const fallback = () => template.render(decisionEvent.explanation, context);

  // Same artifact + same model + same prompt => reuse the stored sentence.
  const cacheKey = { explanationHash: decisionEvent.explanationHash, promptVersion: PROMPT_VERSION };
  if (store && store.getRendering) {
    const hit = store.getRendering(cacheKey);
    if (hit) {
      return {
        text: hit.text,
        source: hit.source,
        model: hit.model,
        latencyMs: 0,
        validation: { ok: true, problems: hit.problems || [], warnings: hit.warnings || [] },
        cached: true,
      };
    }
  }

  const finish = (result) => {
    if (store && store.saveRendering) {
      store.saveRendering({
        ...cacheKey,
        decisionId: decisionEvent.decisionId,
        recordId: decisionEvent.recordId,
        text: result.text,
        source: result.source,
        model: result.model,
        latencyMs: result.latencyMs,
        problems: result.validation.problems,
        warnings: result.validation.warnings,
      });
    }
    return { ...result, cached: false };
  };

  const health = await ollama.isAvailable();
  if (!health.ok || !health.hasModel) {
    return finish({
      text: fallback(),
      source: 'template',
      model: null,
      latencyMs: 0,
      validation: { ok: true, problems: [], warnings: [health.ok ? 'model not pulled' : 'ollama unavailable'] },
    });
  }

  try {
    const prompt = buildPrompt(decisionEvent);
    const { text, model, latencyMs } = await ollama.generate(prompt, { system: SYSTEM_PROMPT });
    const validation = validate(text, decisionEvent);

    if (!validation.ok) {
      // The model said something unsupported — show the reliable text instead.
      return finish({ text: fallback(), source: 'template', model, latencyMs, validation });
    }
    return finish({ text, source: 'llm', model, latencyMs, validation, promptHash: hash(prompt) });
  } catch (err) {
    return finish({
      text: fallback(),
      source: 'template',
      model: null,
      latencyMs: 0,
      validation: { ok: true, problems: [], warnings: [`generation failed: ${err.message}`] },
    });
  }
}

module.exports = { explainDecision, buildPrompt, validate, PROMPT_VERSION, SYSTEM_PROMPT };
