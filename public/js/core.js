/* Shared primitives: escaping, the API client, formatting, DOM wiring.
   Native ES modules — no build step, no dependencies. */

// How often auto-refreshing views re-fetch. The UI tells the user this number,
// so it lives in exactly one place.
export const POLL_MS = 4000;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Every API call goes through here so the CSRF header and error unwrapping are
// impossible to forget.
export async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (method !== 'GET') {
    opts.headers['X-Statusline'] = '1';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body || {});
  }
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch (e) {
      /* not JSON — keep the status text */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const sessionUrl = (sid, sub = '') => `/api/sessions/${encodeURIComponent(sid)}${sub}`;

/* --------------------------------- format --------------------------------- */

export function minutesSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

export function when(iso) {
  if (!iso) return '—';
  const mins = Math.round(minutesSince(iso));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 5)}`;
}

export function basename(p) {
  return p ? String(p).split(/[\\/]/).pop() : '—';
}

export function tokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n === 0) return '<span class="dim">—</span>';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

// Cost is reported by the API per call. Sub-cent classification calls are the
// norm, so show enough precision to be meaningful rather than a row of $0.00.
export function cost(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '<span class="dim">—</span>';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`; // a classification call is ~$0.02; $0.02 vs $0.03 matters
  return `$${usd.toFixed(2)}`;
}

export const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/* ----------------------------------- dom ---------------------------------- */

// Wire handlers after an innerHTML swap: on('[data-label]', 'click', (el) => …).
// Matches zero or more elements, so callers never need an existence check.
export function on(selector, event, handler, root = document) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, (ev) => handler(el, ev)));
}
