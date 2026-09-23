/**
 * Entry point. Deliberately small: it decides "login screen or shell", wires the
 * router, and nothing else.
 *
 * To add a feature you should never need to touch this file — register your
 * module in js/modules/index.js instead.
 */

import { session, setSessionExpiredHandler } from './core/api.js';
import { replace } from './core/dom.js';
import { currentRoute, replaceRoute, onRouteChange, navigate } from './core/router.js';
import { loginView } from './views/login.js';
import { buildShell } from './views/shell.js';

const root = document.getElementById('app');

function showLogin() {
  document.body.classList.remove('signed-in');
  replace(root, loginView(showShell));
}

function showShell(user) {
  document.body.classList.add('signed-in');

  const shell = buildShell(user, () => {
    session.clear();
    replaceRoute('');
    showLogin();
  });
  replace(root, shell.root);

  const open = (route) => {
    const target = route || shell.defaultModuleId;
    if (!target) return;
    if (!route) replaceRoute(target);
    shell.show(target);
  };

  onRouteChange(open);
  open(currentRoute());
}

// A rejected token anywhere in the app returns the user to the login screen.
setSessionExpiredHandler(showLogin);

const existing = session.user();
if (existing) showShell(existing);
else showLogin();

// Exposed for debugging in the browser console; not used by the app itself.
window.crn = { navigate, session };
