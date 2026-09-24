# Frontend

Native ES modules, no build step. The backend serves this folder as static files,
so a change is live on refresh — nothing to compile, install or watch.

---

## Adding a module — the whole procedure

**1. Create `js/modules/my-thing.js`:**

```js
import { api } from '../core/api.js';
import { card, grid, field, input, form, table, slot, replace } from '../core/components.js';

export default {
  id: 'my-thing',                    // URL becomes #/my-thing, must be unique
  title: 'My thing',                 // sidebar label
  group: 'Records',                  // Records | Review | Audit (or a new one)
  order: 50,                         // position within the group
  allow: { roles: ['inspector'] },   // omit for "any signed-in user"
  summary: 'One line under the page title.',

  mount({ user, navigate }) {
    const output = slot();
    return grid(card('My thing', 'What it does', output));
  },
};
```

**2. Add two lines to `js/modules/index.js`:**

```js
import myThing from './my-thing.js';
// ...then add `myThing,` to the MODULES array
```

**Done.** Navigation, routing, the page header and access filtering all happen
automatically. You never edit `app.js` or `shell.js` to add a feature.

---

## Where things live

```
css/
  base.css         design tokens (colours, spacing, radius) + element defaults
  layout.css       app shell: header, sidebar, content, login screen
  components.css   styling for every helper in core/components.js
js/
  app.js           entry point: login-or-shell, wires the router. Rarely changes.
  core/
    api.js         all HTTP calls, grouped to mirror the backend routers
    dom.js         el(), append(), replace() — no app knowledge
    components.js  card, form, table, badge, callout, asyncRegion, attempt…
    access.js      role groups + canAccess()
    router.js      hash routing (#/module-id)
    format.js      dates, hashes, attribute names, pluralisation
    toast.js       transient messages
  shared/
    vocab.js       record types, purposes, reason text, action labels
    explanation.js the XAI artifact + plain-language block (used by 3 modules)
  modules/
    index.js       THE REGISTRY — one line per module
    *.js           one file per feature
  views/
    login.js       sign-in screen
    shell.js       header, sidebar, module mounting
```

## Rules that keep this maintainable

1. **Build from `core/components.js`**, not raw `el()`. If you need a new piece,
   add it there and style it in `components.css` — never style inside a module.
2. **A module owns one screen.** Don't import one module from another; put shared
   pieces in `shared/`.
3. **`mount()` runs on every open.** Build fresh nodes; don't cache DOM across
   mounts.
4. **Load data with `asyncRegion`** so loading and error states look the same
   everywhere:
   ```js
   const region = asyncRegion({
     load: () => api.audit.accessLog(50),
     render: (data) => table(['#'], data.entries.map(e => [e.seq])),
   });
   region.reload();   // whenever you want fresh data
   ```
5. **Use `form({...})`** rather than a bare `<form>` — it disables the button
   while submitting and turns a thrown error into a toast.
6. **One-off actions use `attempt()`** so a failure is a toast, not a crash.
7. **Colours and spacing come from `base.css` variables.** No hardcoded hex.

## Access control — read this

`core/access.js` decides what appears in the sidebar. **It is not security.** The
real gates are the chaincode (which checks the caller's signed X.509 certificate)
and the backend's `requireRole`. The frontend check only avoids showing a user
buttons that would fail.

The role groups in `access.js` mirror the backend. **If you change a
`requireRole(...)` in `backend/src/routes/`, update the matching group here.**

## Checking your work

There is no build, so these commands are the safety net:

```bash
npm run check   # syntax-check every module (no bundler, so a typo shows up here first)
npm test        # node:test suites in test/ for pure-logic modules such as shared/recent-requests.js
```

That catches syntax errors. To catch a bad import or a typo'd named export —
the most common mistake without a bundler — reload the page and check the
browser console; a failed import shows up immediately as the app failing to
render.

## Conventions worth copying

- **Badges** carry meaning by name: `badge(x, 'allow' | 'deny' | 'escalate' | 'neutral')`.
- **Callouts** for results: `callout('good' | 'bad' | 'info' | 'warn', title, ...)`.
- **`mono(value, { truncate: true })`** for hashes and ids in tables.
- **`format.js`** for anything user-facing: `dateTime`, `shortHash`, `mspName`,
  `attributeList`, `count`.
