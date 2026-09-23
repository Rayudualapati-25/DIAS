/**
 * The signed-in application shell: header, sidebar navigation, and the region
 * where the active module renders.
 *
 * The shell knows nothing about individual modules — it works entirely from the
 * registry, so adding a module never requires editing this file.
 */

import { el } from '../core/dom.js';
import { replace, append, hint, card, button } from '../core/components.js';
import { canAccess, ORG_LABEL } from '../core/access.js';
import { MODULES, GROUP_ORDER, moduleById } from '../modules/index.js';
import { navigate } from '../core/router.js';

/** Modules this user may open, sorted by group then order. */
export function visibleModules(user) {
  return MODULES
    .filter((module) => canAccess(user, module.allow))
    .sort((a, b) => {
      const groupDiff = groupRank(a.group) - groupRank(b.group);
      if (groupDiff !== 0) return groupDiff;
      if (a.group !== b.group) return a.group.localeCompare(b.group);
      return (a.order ?? 100) - (b.order ?? 100);
    });
}

function groupRank(group) {
  const index = GROUP_ORDER.indexOf(group);
  return index === -1 ? GROUP_ORDER.length : index;
}

/** Group modules into { group, modules[] } blocks, preserving order. */
function groupModules(modules) {
  const groups = [];
  for (const module of modules) {
    const name = module.group || 'Other';
    let bucket = groups.find((g) => g.group === name);
    if (!bucket) { bucket = { group: name, modules: [] }; groups.push(bucket); }
    bucket.modules.push(module);
  }
  return groups;
}

export function buildShell(user, onSignOut) {
  const content = el('main', { class: 'content', id: 'module-content' });
  const navLinks = new Map();

  const nav = el('nav', { class: 'sidebar' },
    groupModules(visibleModules(user)).map((bucket) =>
      el('div', { class: 'nav-group' },
        el('h4', { class: 'nav-group-title' }, bucket.group),
        bucket.modules.map((module) => {
          const link = el('a', {
            class: 'nav-link',
            href: `#/${module.id}`,
            onclick: (event) => { event.preventDefault(); navigate(module.id); },
          }, module.title);
          navLinks.set(module.id, link);
          return link;
        }))));

  const header = el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'CR'),
      el('div', { class: 'brand-copy' },
        el('strong', {}, 'Crime Records Access Network'),
        el('small', {},
          el('span', { class: 'network-dot', 'aria-hidden': 'true' }),
          'crimechannel · Hyperledger Fabric'))),
    el('div', { class: 'session' },
      el('div', { class: 'who' },
        el('span', {}, user.displayName || user.username),
        el('small', {}, `${ORG_LABEL[user.org] || user.org} · ${user.role}`)),
      button('Sign out', { kind: 'ghost', onclick: onSignOut })));

  const root = el('div', { class: 'app' }, header,
    el('div', { class: 'app-body' }, nav, content));

  /** Render one module into the content area and highlight its nav link. */
  const show = (moduleId) => {
    const module = moduleById(moduleId);

    for (const [id, link] of navLinks) {
      link.classList.toggle('active', id === moduleId);
    }

    if (!module) {
      replace(content, card('Not found', null,
        hint(`No module called "${moduleId}".`)));
      return;
    }
    if (!canAccess(user, module.allow)) {
      // Reachable by typing a URL. The backend would refuse anyway; this just
      // explains it rather than showing a broken screen.
      replace(content, card('Not available for your role', null,
        hint(`"${module.title}" is limited to other roles. `),
        hint('Your role: ', user.role)));
      return;
    }

    replace(content,
      el('div', { class: 'module-head' },
        el('h1', {}, module.title),
        module.summary && el('p', { class: 'module-summary' }, module.summary)));
    try {
      append(content, module.mount({ user, navigate }));
    } catch (error) {
      append(content, card('This module failed to load', null, hint(error.message)));
      // eslint-disable-next-line no-console
      console.error(`[shell] module "${module.id}" threw during mount:`, error);
    }
  };

  return { root, show, defaultModuleId: visibleModules(user)[0]?.id || null };
}
