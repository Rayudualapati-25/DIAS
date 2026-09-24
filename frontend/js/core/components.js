/**
 * Reusable UI pieces.
 *
 * Build new modules out of these rather than raw `el()` calls, so every screen
 * looks and behaves the same. If you need something new, add it here instead of
 * inventing it inside one module.
 */

import { el, append, replace, slot } from './dom.js';
import { toast } from './toast.js';

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/** A titled panel. Most module content should live in one of these. */
export function card(title, hint, ...children) {
  return el('section', { class: 'card' },
    title && el('h2', { class: 'card-title' }, title),
    hint && el('p', { class: 'card-hint' }, hint),
    ...children);
}

/** Responsive column grid — the default layout inside a module. */
export function grid(...children) {
  return el('div', { class: 'grid' }, ...children);
}

/** Side-by-side fields that stack on narrow screens. */
export function row(...children) {
  return el('div', { class: 'row' }, ...children);
}

/** A subheading inside a card. */
export function subheading(text) {
  return el('h3', { class: 'subheading' }, text);
}

// ---------------------------------------------------------------------------
// Text and status
// ---------------------------------------------------------------------------

export function hint(...children) {
  return el('p', { class: 'hint' }, ...children);
}

export function mono(text, { truncate = false } = {}) {
  return el('code', { class: truncate ? 'mono trunc' : 'mono', title: String(text ?? '') },
    text ?? '—');
}

/**
 * A status pill. `kind` drives the colour:
 *   allow | granted | ok | yes   -> green
 *   deny  | denied | no | failed -> red
 *   escalate | pending | warn    -> amber
 *   anything else                -> neutral grey
 */
export function badge(text, kind = 'neutral') {
  return el('span', { class: `badge ${kind}` }, text);
}

/** Green/red pill from a boolean, for verification results. */
export function boolBadge(value, trueText = 'match', falseText = 'mismatch') {
  return badge(value ? trueText : falseText, value ? 'allow' : 'deny');
}

export function empty(message = 'Nothing to show yet.') {
  return el('p', { class: 'empty' }, message);
}

/** A callout box. `tone`: info | good | bad | warn */
export function callout(tone, title, ...children) {
  return el('div', { class: `callout ${tone}` },
    title && el('div', { class: 'callout-title' }, title),
    ...children);
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function field(label, control, help) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    help && el('small', { class: 'field-help' }, help));
}

export function input(name, attrs = {}) {
  return el('input', { name, ...attrs });
}

export function textarea(name, attrs = {}) {
  return el('textarea', { name, rows: '3', ...attrs });
}

/** options: array of strings, or [{ value, label }] */
export function select(name, options, attrs = {}) {
  return el('select', { name, ...attrs },
    options.map((option) => {
      const value = typeof option === 'string' ? option : option.value;
      const label = typeof option === 'string' ? option : option.label;
      return el('option', { value }, label);
    }));
}

export function checkbox(name, label) {
  return el('label', { class: 'checkbox' },
    el('input', { type: 'checkbox', name }),
    el('span', {}, label));
}

export function button(text, {
  kind = 'primary', type = 'button', onclick, small = false, ariaLabel,
} = {}) {
  const classes = ['btn', kind === 'primary' ? '' : kind, small ? 'small' : '']
    .filter(Boolean).join(' ');
  return el('button', {
    class: classes, type, ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ...(onclick ? { onclick } : {}),
  }, text);
}

/** Read a form into a plain object. Checkboxes become booleans. */
export function formValues(form) {
  const out = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    out[element.name] = element.type === 'checkbox' ? element.checked : element.value;
  }
  return out;
}

/**
 * A form whose submit handler is async and cannot double-fire.
 *
 *   form({ submitLabel: 'Search', fields: [...], onSubmit: async (values) => {...} })
 *
 * The submit button disables and shows "Working…" while onSubmit runs, and
 * errors surface as a toast instead of an unhandled rejection.
 */
export function form({ fields = [], submitLabel = 'Submit', onSubmit, extraActions = [] }) {
  const submit = button(submitLabel, { type: 'submit' });
  const original = submitLabel;

  const node = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = 'Working…';
      try {
        await onSubmit(formValues(event.target), event.target);
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = original;
      }
    },
  }, ...fields, el('div', { class: 'actions' }, submit, ...extraActions));

  return node;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * A table that scrolls horizontally rather than breaking the layout.
 * `rows` is an array of arrays of cell contents (nodes or strings).
 */
export function table(headers, rows, { emptyMessage } = {}) {
  if (!rows || rows.length === 0) return empty(emptyMessage);
  return el('div', { class: 'scroll-x' },
    el('table', {},
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, c)))))));
}

/** Two-column label/value table, for showing one object's fields. */
export function detailTable(pairs) {
  return table(['Field', 'Value'], pairs.filter(Boolean));
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Run an async action, turning failures into a toast rather than a crash.
 * Returns the result, or null if it failed — so callers can `if (!x) return;`.
 */
export async function attempt(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(successMessage, 'success');
    return result;
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
}

/**
 * A region that loads its own data and handles the three states for you.
 *
 *   const region = asyncRegion({
 *     load:   () => api.audit.accessLog(50),
 *     render: (data) => table(...),
 *   });
 *   region.reload();      // call again whenever you want fresh data
 *
 * Returns the node, with `.reload()` attached.
 */
export function asyncRegion({ load, render, loadingMessage = 'Loading…', immediate = true }) {
  const node = slot({ class: 'region' });

  const reload = async () => {
    replace(node, hint(loadingMessage));
    try {
      const data = await load();
      replace(node);
      append(node, render(data));
    } catch (error) {
      replace(node, callout('bad', 'Could not load this', hint(error.message)));
    }
  };

  node.reload = reload;
  if (immediate) reload();
  return node;
}

export { slot, replace, append, el };
