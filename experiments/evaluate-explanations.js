'use strict';

/**
 * Does the local LLM write better explanations than a plain template?
 *
 * The paper reports "decisive_attribute_full_text_coverage_rate = 0.781" and
 * calls the text renderer its weakest part. That number is produced by
 * decisive_attribute_text_coverage() in src/seba/xai_quality.py (line 117).
 * This script re-implements the SAME scoring rule so the numbers are comparable,
 * then scores two arms:
 *
 *   A. template  — the deterministic sentence writer (no AI)
 *   B. llm       — the local Ollama model
 *
 * The rule (copied from the Python): an attribute counts as "covered" if the
 * text contains the attribute's words, OR a known hint phrase, OR the concrete
 * value of that attribute.
 *
 * Usage:
 *   npm start                             (in backend/, first)
 *   node experiments/evaluate-explanations.js
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OUT_DIR = path.resolve(__dirname, 'results');
const PAPER_BASELINE = { fullCoverage: 0.781, meanCoverage: 0.9310, source: 'paper Section IV-E / results/tables/explanation_audit_quality_summary.csv' };

// ---------------------------------------------------------------------------
// Scoring: ported from src/seba/xai_quality.py
// ---------------------------------------------------------------------------

/**
 * Hint phrases per decisive attribute. The first group mirrors the paper's
 * ATTRIBUTE_TEXT_HINTS exactly. The three marked NEW have no entry in the
 * paper's table (its synthetic schema had no separate role/clearance/record-type
 * attribute), so hints are added here and this is stated in the report.
 */
const HINTS = Object.freeze({
  'subject.credentialStatus': ['credential'],
  'env.purpose': ['purpose'],
  'object.sensitivityLevel': ['sensitivity', 'sensitive', 'classified'],
  'object.juvenileFlag': ['juvenile'],
  'object.witnessFlag': ['witness'],
  'object.sealed': ['sealed'],
  'subject.jurisdiction': ['cross jurisdiction', 'jurisdiction'],
  'object.jurisdiction': ['cross jurisdiction', 'jurisdiction'],
  'subject.caseAssignments': ['assigned', 'assignment', 'case'],
  'object.caseId': ['assigned', 'assignment', 'case'],
  'env.approvalToken': ['approval', 'token'],
  'env.emergencyFlag': ['approval', 'token', 'emergency'],
  action: ['action', 'view', 'export', 'annotate'],
  // NEW — not present in the paper's hint table.
  'subject.role': ['role', 'rank', 'officer', 'constable', 'inspector', 'counsel', 'judge', 'analyst'],
  'subject.clearance': ['clearance'],
  'object.recordType': ['record type', 'fir', 'case diary', 'report'],
  'subject.mspId': ['organization', 'organisation', 'department'],
});

const NEW_HINT_KEYS = ['subject.role', 'subject.clearance', 'object.recordType', 'subject.mspId'];

/** Same normalisation as the Python: lowercase, strip punctuation, squeeze spaces. */
function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Concrete value of a dotted attribute on a decision event, if any. */
function valueOf(attribute, decisionEvent) {
  const [group, field] = attribute.includes('.') ? attribute.split('.') : [null, attribute];
  const source = group === 'subject' ? decisionEvent.subject
    : group === 'env' ? decisionEvent.environment
      : group === 'object' ? decisionEvent.record
        : decisionEvent;
  const value = source ? source[field] : undefined;
  if (value === undefined || value === null) return null;
  // The Python skips booleans, because "true"/"false" never appear in prose.
  if (typeof value === 'boolean') return null;
  return String(value);
}

/** Fraction of decisive attributes reflected in the text. 0..1 */
function attributeCoverage(attributes, text, decisionEvent) {
  if (!attributes || attributes.length === 0) return 0;
  const haystack = normalize(text);
  let hits = 0;

  for (const attribute of attributes) {
    const candidates = new Set();
    // 1. the attribute's own words: "object.sensitivityLevel" -> "sensitivity level"
    candidates.add(attribute.replace(/^[a-z]+\./, '').replace(/([A-Z])/g, ' $1'));
    // 2. known hint phrases
    for (const hint of HINTS[attribute] || []) candidates.add(hint);
    // 3. the concrete value
    const value = valueOf(attribute, decisionEvent);
    if (value) candidates.add(value);

    for (const candidate of candidates) {
      if (candidate && haystack.includes(normalize(candidate))) { hits += 1; break; }
    }
  }
  return hits / attributes.length;
}

// ---------------------------------------------------------------------------
// Driving the live system
// ---------------------------------------------------------------------------

async function api(method, urlPath, { token, body } = {}) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  return { ok: json.success, data: json.data, error: json.error };
}

async function login(username) {
  const { data, error } = await api('POST', '/auth/login', { body: { username } });
  if (!data) throw new Error(`login ${username}: ${error}`);
  return data.token;
}

/**
 * Build a set of decisions covering several different reason codes, so the
 * comparison is not measured on one repeated case.
 */
async function collectDecisions(runId) {
  const tokens = {};
  for (const u of ['insp.sharma', 'const.verma', 'dc.nair', 'insp.rathore', 'pp.mehta', 'judge.rana']) {
    tokens[u] = await login(u);
  }

  const plain = `FIR-EVAL-${runId}-A`;
  const juvenile = `FIR-EVAL-${runId}-B`;
  const sealed = `FIR-EVAL-${runId}-C`;

  const meta = (extra = {}) => ({
    caseId: 'CASE-2026-001', recordType: 'fir', sensitivityLevel: 'medium',
    juvenileFlag: false, witnessFlag: false,
    owningStation: 'PS-Central', jurisdiction: 'district-north', ...extra,
  });

  for (const [id, m] of [[plain, meta()], [juvenile, meta({ juvenileFlag: true })], [sealed, meta()]]) {
    const created = await api('POST', '/records', {
      token: tokens['insp.sharma'],
      body: { recordId: id, payload: { fir: id, summary: 'evaluation workload record' }, meta: m },
    });
    if (!created.ok) throw new Error(`record ${id}: ${created.error}`);
  }
  const sealResult = await api('POST', `/records/${sealed}/seal`, { token: tokens['judge.rana'] });
  if (!sealResult.ok) throw new Error(`seal: ${sealResult.error}`);

  // Each entry deliberately triggers a different policy rule.
  const scenarios = [
    { label: 'allow / assigned inspector', user: 'insp.sharma', recordId: plain, purpose: 'investigation' },
    { label: 'escalate / low clearance', user: 'const.verma', recordId: plain, purpose: 'investigation' },
    { label: 'deny / role has no permission', user: 'dc.nair', recordId: plain, purpose: 'defense-preparation' },
    { label: 'deny / revoked credential', user: 'insp.rathore', recordId: plain, purpose: 'investigation' },
    { label: 'deny / juvenile record', user: 'const.verma', recordId: juvenile, purpose: 'investigation' },
    { label: 'escalate / sealed record', user: 'pp.mehta', recordId: sealed, purpose: 'prosecution' },
  ];

  const decisions = [];
  for (const s of scenarios) {
    const requested = await api('POST', '/access/request', {
      token: tokens[s.user],
      body: { recordId: s.recordId, action: 'view', purpose: s.purpose },
    });
    if (!requested.ok) throw new Error(`${s.label}: ${requested.error}`);
    const record = await api('GET', `/records/${s.recordId}`, { token: tokens['insp.sharma'] });
    decisions.push({
      ...s,
      token: tokens[s.user],
      event: { ...requested.data, record: record.data },
    });
  }
  return decisions;
}

// ---------------------------------------------------------------------------

function summarise(rows, { isLlmArm = false } = {}) {
  const coverages = rows.map((r) => r.coverage);
  const mean = coverages.reduce((a, b) => a + b, 0) / coverages.length;
  const full = coverages.filter((c) => c === 1).length / coverages.length;
  const latencies = rows.map((r) => r.latencyMs).filter((n) => n > 0).sort((a, b) => a - b);
  return {
    n: rows.length,
    meanCoverage: Number(mean.toFixed(4)),
    fullCoverageRate: Number(full.toFixed(4)),
    labelFidelityRate: Number((rows.filter((r) => r.labelFaithful).length / rows.length).toFixed(4)),
    counterfactualMentionRate: Number(
      (rows.filter((r) => r.counterfactualExpected ? r.counterfactualMentioned : true).length / rows.length).toFixed(4)),
    // Only meaningful for the LLM arm: the template arm is template by definition.
    fallbackRate: isLlmArm
      ? Number((rows.filter((r) => r.source === 'template').length / rows.length).toFixed(4))
      : 'n/a',
    latencyP50Ms: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
  };
}

/** Does the text state the decision it is supposed to? */
function labelFaithful(text, decision) {
  const lower = text.toLowerCase();
  const WRONG = { allow: ['denied', 'escalated'], deny: ['allowed', 'granted'], escalate: ['allowed', 'granted', 'denied'] };
  return !(WRONG[decision] || []).some((w) => lower.includes(w));
}

function markdown(report) {
  const t = report.arms.template;
  const l = report.arms.llm;
  const row = (name, key, fmt = (v) => v) =>
    `| ${name} | ${fmt(t[key])} | ${fmt(l[key])} |`;

  return [
    '# Explanation quality: template vs local LLM',
    '',
    `Generated ${report.generatedAtUtc} · model \`${report.model}\` · ${report.arms.template.n} decisions covering ${report.scenarios.length} distinct policy rules.`,
    '',
    '## Scores',
    '',
    '| Metric | Template only (no AI) | LLM arm (LLM + fallback) |',
    '|---|---|---|',
    row('Decisive-attribute coverage (mean)', 'meanCoverage'),
    row('Full coverage rate', 'fullCoverageRate'),
    row('Decision-label fidelity', 'labelFidelityRate'),
    row('Counterfactual mentioned', 'counterfactualMentionRate'),
    row('Fell back to template (validator rejected)', 'fallbackRate'),
    row('Render latency p50 (ms)', 'latencyP50Ms'),
    '',
    `**Paper baseline for reference:** full coverage ${PAPER_BASELINE.fullCoverage}, mean coverage ${PAPER_BASELINE.meanCoverage} (${PAPER_BASELINE.source}).`,
    '',
    '## How to read this',
    '',
    'The scoring rule is ported from `src/seba/xai_quality.py:117`, so the coverage',
    'numbers are computed the same way as the paper\'s. Two honest caveats:',
    '',
    '0. **The LLM arm measures what the user actually sees, not raw model quality.**',
    '   When the validator rejects a generation the arm falls back to template',
    `   wording, and that fallback text is what gets scored. At a fallback rate of`,
    `   ${l.fallbackRate}, a meaningful share of the LLM arm's score is template text.`,
    '   Read the per-scenario table\'s "LLM source" column to see which is which.',
    '1. **The metric favours templates.** It rewards literally naming the decisive',
    '   attributes, and a template can be written to name all of them every time.',
    '   The Python source itself calls it "a weak textual proxy, not a human',
    '   explanation-quality score." A template scoring higher than the LLM is the',
    '   expected outcome, not a bug — it means fluency is not what this metric measures.',
    '2. **Four attribute hints were added** that the paper\'s table lacks',
    `   (${NEW_HINT_KEYS.join(', ')}), because the Fabric policy uses attributes the`,
    '   paper\'s synthetic schema did not have. Without them those attributes could',
    '   never be scored as covered.',
    '',
    '## Per-scenario detail',
    '',
    '| Scenario | Decision | Template coverage | LLM coverage | LLM source |',
    '|---|---|---|---|---|',
    ...report.perScenario.map((s) =>
      `| ${s.label} | ${s.decision} | ${s.templateCoverage} | ${s.llmCoverage} | ${s.llmSource} |`),
    '',
    '## Example LLM output',
    '',
    ...report.perScenario.slice(0, 3).flatMap((s) => [
      `**${s.label}** (${s.decision})`, '', `> ${s.llmText}`, '',
    ]),
  ].join('\n');
}

async function main() {
  const runId = Date.now();
  process.stdout.write('Creating records and collecting decisions...\n');
  const decisions = await collectDecisions(runId);

  const templateRows = [];
  const llmRows = [];
  const perScenario = [];
  let model = null;

  for (const d of decisions) {
    const attrs = d.event.explanation.decisiveAttributes || [];
    const decision = d.event.explanation.decision;
    const counterfactualExpected = Boolean(d.event.explanation.counterfactual);

    // Arm A — template. Force it by asking the module directly.
    const templateRenderer = require('../backend/src/llm/template');
    const templateText = templateRenderer.render(d.event.explanation, {
      subject: d.event.subject, environment: d.event.environment, record: d.event.record,
    });

    // Arm B — the live endpoint (uses the LLM, falls back if it misbehaves).
    process.stdout.write(`  ${d.label}...\n`);
    const explained = await api('POST', `/explain/${d.recordId}/${d.event.decisionId}`, { token: d.token });
    if (!explained.ok) throw new Error(`explain ${d.label}: ${explained.error}`);
    model = explained.data.model || model;

    const mk = (text, source, latencyMs) => ({
      coverage: attributeCoverage(attrs, text, d.event),
      labelFaithful: labelFaithful(text, decision),
      counterfactualExpected,
      counterfactualMentioned: counterfactualExpected
        ? normalize(text).includes(normalize(String(d.event.explanation.counterfactual).slice(0, 25)))
          || /would change|if the requester|upgrade/i.test(text)
        : false,
      source,
      latencyMs,
    });

    const tRow = mk(templateText, 'template', 0);
    const lRow = mk(explained.data.text, explained.data.source, explained.data.latencyMs);
    templateRows.push(tRow);
    llmRows.push(lRow);

    perScenario.push({
      label: d.label,
      decision,
      decisiveAttributes: attrs,
      templateCoverage: Number(tRow.coverage.toFixed(2)),
      llmCoverage: Number(lRow.coverage.toFixed(2)),
      llmSource: explained.data.source,
      llmText: explained.data.text,
      templateText,
      problems: explained.data.problems,
    });
  }

  const report = {
    generatedAtUtc: new Date().toISOString(),
    model,
    paperBaseline: PAPER_BASELINE,
    newHintKeys: NEW_HINT_KEYS,
    scenarios: decisions.map((d) => d.label),
    arms: {
      template: summarise(templateRows),
      llm: summarise(llmRows, { isLlmArm: true }),
    },
    perScenario,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'explanation_quality.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT_DIR, 'explanation_quality.md'), `${markdown(report)}\n`);
  process.stdout.write(`\n${markdown(report)}\n`);
}

main().catch((err) => {
  process.stderr.write(`evaluation failed: ${err.message}\n`);
  process.exitCode = 1;
});
