'use strict';

/** Tiny client for Ollama, the local LLM runner. */

const { OLLAMA_URL, OLLAMA_MODEL, OLLAMA_SEED, OLLAMA_TIMEOUT_MS } = require('../config');

/** Is Ollama running right now? Used so the app can degrade instead of erroring. */
async function isAvailable() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    const models = (body.models || []).map((m) => m.name);
    return { ok: true, models, hasModel: models.includes(OLLAMA_MODEL) };
  } catch {
    return { ok: false, models: [], hasModel: false };
  }
}

/** Ask the model to complete a prompt. */
async function generate(prompt, { system } = {}) {
  const started = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      ...(system ? { system } : {}),
      stream: false,
      options: {
        temperature: 0,
        top_p: 1,
        seed: OLLAMA_SEED,
        num_predict: 220,
      },
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`ollama returned ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const text = (body.response || '').trim();
  if (!text) throw new Error('ollama returned an empty response');

  return { text, model: OLLAMA_MODEL, latencyMs: Date.now() - started };
}

module.exports = { isAvailable, generate };
