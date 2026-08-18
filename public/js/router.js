/* Path router: /<view>[/<arg>] → a registered render function, plus the
   auto-refresh timer. Real URLs (History API), so every page is linkable,
   bookmarkable and reloadable — both servers serve the app shell for any
   registered view path. Views register themselves through app.js, so this
   module imports none of them (no cycles). */
import { esc, POLL_MS } from './core.js';

const views = new Map(); // name → { render, autoRefresh, navTab }
let mount = null;
let fallback = '/sessions';
let current = { name: null, arg: null };
let paused = false;

/** render(mountEl, arg) may be async; it owns the contents of the mount node. */
export function registerView(name, render, { autoRefresh = false, navTab = name } = {}) {
  views.set(name, { render, autoRefresh, navTab });
}

// Suspend auto-refresh while the user is typing into an inline editor —
// re-rendering underneath them would discard their input.
export function pauseRefresh(value) {
  paused = value;
}

/** Programmatic navigation — the pushState equivalent of setting location.hash. */
export function navigate(path, { replace = false } = {}) {
  const url = path.startsWith('/') ? path : `/${path}`;
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  render();
}

function parse(pathname) {
  const [name, arg] = pathname.replace(/^\/+/, '').split('/');
  return { name: name || '', arg: arg ? decodeURIComponent(arg) : undefined };
}

export async function render() {
  // Old #view/arg bookmarks (and any link that predates path routing) keep
  // working: rewrite to the real URL once, then render it.
  if (location.hash.length > 1 && views.has(parse(location.hash.slice(1)).name)) {
    history.replaceState({}, '', '/' + location.hash.slice(1));
  }
  // URL correction happens in place, never by re-entering render(): recursing
  // here would only terminate because replaceState moves location, which is a
  // stack overflow waiting for the first unregistered fallback.
  let { name, arg } = parse(location.pathname);
  if (!views.has(name)) {
    history.replaceState({}, '', fallback);
    ({ name, arg } = parse(fallback));
  }
  const view = views.get(name);
  if (!view) {
    mount.innerHTML = `<div class="alert alert-danger">No view registered for ${esc(fallback)}.</div>`;
    return;
  }
  current = { name, arg };
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('active', a.dataset.tab === view.navTab));
  try {
    await view.render(mount, arg);
  } catch (e) {
    mount.innerHTML = `<div class="alert alert-danger">Failed to load: ${esc(e.message)} — is the watcher running?</div>`;
  }
}

// Same-origin, unmodified left clicks on app links navigate in place; anything
// else (new tab, download, external host, #fragment) is left to the browser.
function interceptLinks() {
  document.addEventListener('click', (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest('a');
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin) return;
    if (!views.has(parse(a.pathname).name)) return; // /login, /join, static files
    ev.preventDefault();
    if (a.pathname + a.search !== location.pathname + location.search) navigate(a.pathname + a.search);
  });
}

export function start(mountEl) {
  mount = mountEl;
  interceptLinks();
  window.addEventListener('popstate', () => {
    paused = false; // a navigation always abandons any open editor
    render();
  });
  // A hidden tab burns nothing; coming back re-renders immediately so the
  // "updated at" stamp is never a lie.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) render();
  });
  setInterval(() => {
    if (!paused && !document.hidden && views.get(current.name)?.autoRefresh) render();
  }, POLL_MS);
  render();
}
