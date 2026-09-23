'use strict';

const state = { context: null, lastRequest: null, lastEvidence: null, repeats: 0 };
const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function renderProfile() {
  const profile = state.context.profile;
  if (!profile) return;
  el('identity-output').textContent = `${profile.name} — ${profile.title}`;
  el('session-name').textContent = profile.name;
  el('session-title').textContent = profile.title;
  el('session-avatar').textContent = initials(profile.name);
  el('session-chip').hidden = false;
  const credentialClass = profile.credentialStatus === 'active' ? '' : ' alert';
  el('profile-card').innerHTML = `
    <div class="avatar">${escapeHtml(initials(profile.name))}</div>
    <div><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profile.title)}</small></div>
    <div class="identity-tags">
      <span class="tag">${escapeHtml(profile.role)}</span>
      <span class="tag">${escapeHtml(profile.clearance)} clearance</span>
      <span class="tag">${escapeHtml(profile.jurisdiction)}</span>
      <span class="tag${credentialClass}">${escapeHtml(profile.credentialStatus)}</span>
      <span class="tag">${escapeHtml(profile.caseAssignments || 'no assignment')}</span>
    </div>`;
}

function renderResource() {
  const selected = el('resource-select').value;
  const record = state.context.resources.find((item) => item.recordId === selected);
  if (!record) {
    el('resource-card').innerHTML =
      '<p class="hint">No record pinned. The record ID named in your request will be looked up from the registry.</p>';
    return;
  }
  const rows = [
    ['Record', record.recordId], ['Case', record.caseId], ['Type', record.recordType],
    ['Sensitivity', record.sensitivityLevel], ['Jurisdiction', record.jurisdiction],
    ['Sealed', record.sealed ? 'yes' : 'no'],
    ['Juvenile protected', record.juvenileFlag ? 'yes' : 'no'],
    ['Victim protected', record.victimProtectionFlag ? 'yes' : 'no'],
  ];
  el('resource-card').innerHTML = rows.map(([label, value]) =>
    `<div class="attribute"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  ).join('');
}

function renderDecision(payload) {
  const result = payload.result;
  const panel = el('result-panel');
  panel.classList.remove('empty');
  const symbol = result.decision === 'allow' ? '✓' : result.decision === 'deny' ? '×' : '!';
  panel.innerHTML = `
    <div class="result-head">
      <div class="decision-title">
        <span class="decision-mark ${escapeHtml(result.decision)}">${symbol}</span>
        <div><h2>${escapeHtml(result.decision)}</h2><p>${escapeHtml(result.reasonCode)} · ${escapeHtml(result.decisionSource)}</p></div>
      </div>
      <span class="latency">${escapeHtml(payload.evidence.latencyMs)} ms inference</span>
    </div>
    <p class="explanation">${escapeHtml(result.explanation)}</p>
    <div class="result-grid">
      <div class="result-fact"><span>Interpreted action</span><strong>${escapeHtml(result.action)}</strong></div>
      <div class="result-fact"><span>Interpreted purpose</span><strong>${escapeHtml(result.purpose)}</strong></div>
      <div class="result-fact"><span>Model output</span><strong>${result.modelOutputConsistent ? 'Validated' : 'Safety escalated'}</strong></div>
    </div>
    <div class="attribute-chips">${result.decisiveAttributes.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
    ${result.counterfactual ? `<p class="counterfactual"><strong>What could change this:</strong> ${escapeHtml(result.counterfactual)}</p>` : ''}
    ${evidenceBlock(payload.evidence)}`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Reproducibility: the interface uses the same decoding settings as the offline
// evaluator (temperature 0, top_p 1, seed 42, 192 max tokens) and the same prompt
// contract, so an identical request must return a byte-identical model output.
function evidenceBlock(evidence) {
  const verdict = state.repeats === 0
    ? ''
    : `<p class="repro-verdict ${state.reproMatched ? 'match' : 'differ'}">
         ${state.reproMatched
           ? `Identical output on ${state.repeats + 1} runs — raw model output hash unchanged.`
           : 'Output differed between runs — this request is not reproducible.'}
       </p>`;
  return `
    <details class="evidence" open>
      <summary>Reproducibility evidence</summary>
      <div class="evidence-grid">
        <div><span>Model version</span><code>${escapeHtml(evidence.modelVersion)}</code></div>
        <div><span>Adapter SHA-256</span><code>${escapeHtml(evidence.adapterSha256)}</code></div>
        <div><span>Prompt SHA-256</span><code>${escapeHtml(evidence.promptSha256)}</code></div>
        <div><span>Raw output SHA-256</span><code>${escapeHtml(evidence.rawOutputSha256)}</code></div>
        <div><span>Decoding</span><code>temperature 0 · top_p 1 · seed 42 · max_tokens 192</code></div>
      </div>
      ${verdict}
      <button id="repeat-button" type="button" class="ghost-button">Run the identical request again</button>
    </details>`;
}

async function repeatRequest() {
  if (!state.lastRequest) return;
  const button = el('repeat-button');
  button.disabled = true;
  button.textContent = 'Re-running…';
  try {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.lastRequest),
    });
    const payload = await response.json();
    if (!response.ok) return renderError(payload);
    state.repeats += 1;
    state.reproMatched = payload.evidence.rawOutputSha256 === state.lastEvidence.rawOutputSha256;
    renderDecision(payload);
  } catch (error) {
    renderError({ error: error.message, explanation: 'The repeat request did not complete.' });
  }
}

function renderError(payload) {
  const panel = el('result-panel');
  panel.classList.remove('empty');
  panel.innerHTML = `
    <div class="result-head"><div class="decision-title"><span class="decision-mark escalate">!</span><div><h2>Escalate</h2><p>Validated model decision unavailable</p></div></div></div>
    <p class="explanation">${escapeHtml(payload.explanation || payload.error)}</p>
    <p class="counterfactual"><strong>System detail:</strong> ${escapeHtml(payload.error)}</p>`;
}

async function checkHealth() {
  const dot = el('model-dot');
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    dot.className = `status-dot ${health.ready ? 'ready' : 'offline'}`;
    el('model-status').textContent = health.ready ? 'Qwen ready' : 'Qwen offline';
  } catch (_error) {
    dot.className = 'status-dot offline';
    el('model-status').textContent = 'Qwen offline';
  }
}

async function loadContext() {
  const response = await fetch('/api/context');
  if (response.status === 401) {
    window.location.assign('/login.html');
    return;
  }
  state.context = await response.json();
  el('resource-select').innerHTML = [
    '<option value="">Read the record ID from my request</option>',
    ...state.context.resources.map((record) =>
      `<option value="${escapeHtml(record.recordId)}">${escapeHtml(record.label)} — ${escapeHtml(record.recordId)}</option>`),
  ].join('');
  el('rule-list').innerHTML = state.context.policy.orderedRules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join('');
  renderProfile();
  renderResource();
}

async function submitDecision(event) {
  event.preventDefault();
  const button = el('submit-button');
  button.disabled = true;
  button.querySelector('span').textContent = 'Qwen is deciding…';
  const request = {
    recordId: el('resource-select').value,
    query: el('query-input').value,
    emergencyFlag: el('emergency-flag').checked,
    approvalTokenPresent: el('approval-flag').checked,
  };
  state.lastRequest = request;
  state.repeats = 0;
  try {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (response.status === 401) {
      window.location.assign('/login.html');
      return;
    }
    const payload = await response.json();
    if (!response.ok) {
      renderError(payload);
    } else {
      state.lastEvidence = payload.evidence;
      renderDecision(payload);
    }
  } catch (error) {
    renderError({ error: error.message, explanation: 'The interface could not reach the standalone decision service.' });
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Evaluate request';
  }
}

async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => null);
  window.location.assign('/login.html');
}

document.addEventListener('DOMContentLoaded', async () => {
  el('resource-select').addEventListener('change', renderResource);
  el('decision-form').addEventListener('submit', submitDecision);
  el('signout-button').addEventListener('click', signOut);
  el('result-panel').addEventListener('click', (event) => {
    if (event.target.id === 'repeat-button') repeatRequest();
  });
  await Promise.all([loadContext(), checkHealth()]);
});
