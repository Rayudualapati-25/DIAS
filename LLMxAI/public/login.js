'use strict';

const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function showError(message) {
  const box = el('login-error');
  box.textContent = message;
  box.hidden = !message;
}

async function loadDirectory() {
  try {
    const response = await fetch('/api/directory');
    const body = await response.json();
    el('officer-list').innerHTML = body.profiles.map((profile) => `
      <li>
        <button type="button" class="officer-option" data-id="${escapeHtml(profile.id)}">
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(profile.title)}</small>
          <code>${escapeHtml(profile.id)}</code>
        </button>
      </li>`).join('');
    el('officer-list').addEventListener('click', (event) => {
      const option = event.target.closest('.officer-option');
      if (!option) return;
      el('officer-id').value = option.dataset.id;
      showError('');
      el('login-form').requestSubmit();
    });
  } catch (_error) {
    showError('The interface could not load the registered officer list.');
  }
}

async function signIn(event) {
  event.preventDefault();
  const button = el('login-button');
  button.disabled = true;
  showError('');
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: el('officer-id').value.trim() }),
    });
    const body = await response.json();
    if (!response.ok) {
      showError(body.error || 'Sign in failed.');
      return;
    }
    window.location.assign('/');
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  el('login-form').addEventListener('submit', signIn);
  const active = await fetch('/api/session').catch(() => null);
  if (active && active.ok) {
    window.location.assign('/');
    return;
  }
  await loadDirectory();
});
