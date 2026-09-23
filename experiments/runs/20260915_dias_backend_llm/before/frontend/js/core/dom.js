/**
 * DOM building blocks.
 *
 * Every function returns a NEW node and never mutates one it was given, so
 * views compose without hidden side effects.
 *
 * This file has no knowledge of the application — keep domain logic out of it.
 */

/**
 * Create an element.
 *   el('div', { class: 'card' }, child, child, ...)
 *
 * Attribute handling:
 *   class            -> className
 *   html             -> innerHTML (use sparingly)
 *   on<Event>        -> addEventListener, e.g. onclick, onsubmit
 *   true             -> boolean attribute
 *   null/undefined/false -> attribute skipped entirely
 *
 * Children are flattened, and null/undefined/false children are dropped, so
 * `cond && el(...)` works inline.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  append(node, children);
  return node;
}

/** Append children, flattening arrays and skipping empty values. */
export function append(parent, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/** Replace a node's children in one go. */
export function replace(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/** Shorthand for a plain container, useful as a placeholder to fill later. */
export function slot(attrs = {}) {
  return el('div', attrs);
}

export function fragment(...children) {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}
