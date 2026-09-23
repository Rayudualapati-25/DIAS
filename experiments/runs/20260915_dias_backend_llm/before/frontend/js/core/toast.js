/**
 * Transient messages. Kept separate from components.js so any file can import
 * it without pulling in the whole component library.
 */

let timer = null;

/** kind: success | error | info */
export function toast(message, kind = 'info') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { node.hidden = true; }, kind === 'error' ? 6000 : 4000);
}
