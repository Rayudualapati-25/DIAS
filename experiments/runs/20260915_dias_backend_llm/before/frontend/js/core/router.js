/**
 * Hash routing: `#/search`, `#/audit-trail`, ...
 *
 * Why a router at all: with many modules you want a refresh to keep you on the
 * same screen, and you want to send someone a link to one. The URL is the single
 * source of truth for "which module is open".
 */

const listeners = new Set();

/** The module id in the URL, or null. */
export function currentRoute() {
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  return hash === '' ? null : hash;
}

/** Change the route. Triggers the hashchange listener. */
export function navigate(moduleId) {
  const next = `#/${moduleId}`;
  if (window.location.hash === next) {
    // Same route requested — notify anyway so a nav click always feels responsive.
    listeners.forEach((fn) => fn(moduleId));
    return;
  }
  window.location.hash = next;
}

/** Replace the route without adding a history entry (used for defaults). */
export function replaceRoute(moduleId) {
  const url = `${window.location.pathname}#/${moduleId}`;
  window.history.replaceState(null, '', url);
}

export function onRouteChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

window.addEventListener('hashchange', () => {
  const route = currentRoute();
  listeners.forEach((fn) => fn(route));
});
