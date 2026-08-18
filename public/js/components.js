/* Presentational fragments shared by more than one view.
   Every function returns an HTML string and escapes its own text; parameters
   documented as `html` are inserted verbatim and must already be escaped. */
import { esc, when } from './core.js';

/* --------------------------------- badges --------------------------------- */

const STATE_LABELS = {
  unclassified: 'unclassified',
  pending: 'classifying…',
  classified: 'classified',
  stale: 're-check due',
  classification_failed: 'failed',
};
const STATE_TITLES = {
  stale: 'classified, but new activity accumulated — will re-classify when idle',
};

// Bootstrap badge + the theme color the state means. Kept in one map so a
// state and its color can never drift apart across views.
const STATE_COLORS = {
  unclassified: 'text-bg-secondary',
  pending: 'text-bg-warning',
  classified: 'text-bg-success',
  stale: 'text-bg-warning',
  classification_failed: 'text-bg-danger',
};

export function stateBadge(state) {
  const title = STATE_TITLES[state] ? ` title="${esc(STATE_TITLES[state])}"` : '';
  const color = STATE_COLORS[state] || 'text-bg-secondary';
  return `<span class="badge ${color}"${title}>${esc(STATE_LABELS[state] || state)}</span>`;
}

export function badge(text, cls = 'text-bg-secondary') {
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

// Sessions in a linked git worktree are flagged, because the repo name alone
// would suggest they share a working copy with everything else in that repo.
// The ordinary main worktree renders nothing at all.
export function worktreeBadge(s) {
  if (!s || !s.git_worktree) return '';
  return `<span class="badge text-bg-dark border border-secondary" title="git worktree — a separate working copy of this repo">⑂ ${esc(
    s.git_worktree
  )}</span>`;
}

// kind: '' warning (the default), 'error', or 'tip' (an offer, not a problem).
const BANNER_CLASS = { '': 'alert-warning', error: 'alert-danger', tip: 'alert-primary d-flex gap-3 align-items-start' };

export function banner(html, kind = '') {
  return `<div class="alert ${BANNER_CLASS[kind] || 'alert-warning'}">${html}</div>`;
}

/* --------------------------------- layout --------------------------------- */

// [[label, html], …] → the labelled grid used on every detail card. Falsy
// entries are dropped so callers can build rows conditionally.
export function metaGrid(items) {
  const cells = items
    .filter(Boolean)
    .map(([label, html]) => `<div><b>${esc(label)}</b>${html || '—'}</div>`)
    .join('');
  return `<div class="meta-grid">${cells}</div>`;
}

export function subhead(text) {
  return `<b class="subhead">${esc(text)}</b>`;
}

/* ------------------------------ classification ----------------------------- */

// What this classification cost, for the provenance note ("· $0.0567 · 7.4k in / 0.5k out").
// Empty string for calls without cost data (inherited, heuristic, pre-tracking).
export function costNote(meta) {
  if (meta?.cost_usd == null) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
  const tokens = meta.input_tokens ? ` · ${k(meta.input_tokens)} in / ${k(meta.output_tokens || 0)} out` : '';
  return ` · $${Number(meta.cost_usd).toFixed(4)}${tokens}`;
}

export function techChips(techs) {
  return (techs || [])
    .map((t) => {
      const unverified = t.evidence === 'hands_on' && t.verified === false;
      const title = (t.basis || []).join(', ') + (unverified ? ' — claimed by classifier, no tool evidence' : '');
      return `<span class="chip ${esc(t.evidence)}${unverified ? ' unverified' : ''}" title="${esc(title)}">${esc(
        t.name
      )} · ${esc(t.evidence)}${unverified ? '?' : ''}</span>`;
    })
    .join('');
}

export function confidenceBar(conf) {
  const pct = Math.round((conf || 0) * 100);
  return `<span class="cls-conf" title="confidence">${pct}%<span class="conf"><i style="width:${pct}%"></i></span></span>`;
}

/* -------------------------------- projects -------------------------------- */

// Stable accent color per project so same-project rows read as one group.
// Muted-but-distinct hues that sit well on the dark panel background.
const PROJECT_COLORS = [
  '#818cf8', // indigo
  '#2dd4bf', // teal
  '#fbbf24', // amber
  '#f472b6', // pink
  '#a78bfa', // violet
  '#22d3ee', // cyan
  '#a3e635', // lime
  '#fb923c', // orange
  '#34d399', // emerald
  '#f87171', // red
];

function projectColor(s) {
  const key = (s.project && s.project.id) || String(s.git_root || s.primary_cwd || '').toLowerCase();
  if (!key) return null;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length];
}

export function projectDot(s) {
  const color = projectColor(s);
  return color ? `<span class="prj-dot" style="background:${color}"></span>` : '';
}

/* ------------------------------- experience -------------------------------- */

// One practitioner-experience doc (experience-core shape), shared by the local
// and cloud UIs. Counts are DISTINCT PROJECTS (the anti-inflation contract);
// this renderer shows raw facts and uncertainty and never invents scores.
// Unverified hands_on keeps the dashed-"?" convention from session/project chips.

function traceLine(p) {
  const name = p.misc ? 'miscellaneous sessions' : p.project_name;
  const flags = [
    p.verified ? 'tool-verified' : p.max_evidence === 'hands_on' ? 'unverified claim' : null,
    p.depth_max,
    p.classifiers && p.classifiers.some((c) => c !== 'claude-cli') ? `via ${p.classifiers.join('/')}` : null,
    p.min_confidence != null ? `conf ≥${p.min_confidence}` : null,
  ].filter(Boolean).join(' · ');
  return `<div class="small">· <b>${esc(name)}</b> — ${esc(p.max_evidence)}, ${p.sessions} session(s)
    <span class="dim">(${when(p.first_seen)} → ${when(p.last_seen)}${flags ? ' · ' + esc(flags) : ''})</span></div>`;
}

function capabilityRow(c) {
  if (c.max_evidence === 'mentioned') return '';
  const unverified = c.max_evidence === 'hands_on' && !(c.verified_projects > 0);
  const depths = Object.entries(c.depth_projects || {}).filter(([, n]) => n > 0).map(([d, n]) => `${d}×${n}`).join(', ');
  const uncertain = [
    c.uncertainty?.any_heuristic ? 'heuristic-classified' : null,
    c.uncertainty?.any_inherited ? 'inherited' : null,
  ].filter(Boolean).join(', ');
  return `<div class="exp-cap">
    <span class="chip ${esc(c.max_evidence)}${unverified ? ' unverified' : ''}"
      title="${esc(unverified ? 'hands_on claimed by classifier, no tool evidence in any project' : '')}">${esc(c.name || c.canonical)}${unverified ? '?' : ''}</span>
    <span class="small">${c.distinct_projects} project${c.distinct_projects === 1 ? '' : 's'}
      (${c.verified_projects} tool-verified)${depths ? ` · ${esc(depths)}` : ''}
      · ${when(c.first_used)} → ${when(c.last_used)}
      ${uncertain ? `<span class="dim">· ${esc(uncertain)}</span>` : ''}</span>
    <details class="small"><summary class="dim">evidence</summary>${(c.projects || []).map(traceLine).join('')}</details>
  </div>`;
}

export function experienceDoc(doc) {
  const t = doc.totals;
  const excluded = Object.entries(t.excluded || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k.replace('_sessions', '')}×${n}`)
    .join(', ');
  const who = doc.practitioner;
  const caps = (doc.capabilities || []).map(capabilityRow).join('');
  return `<div class="card">
      <div class="proj-head"><h2>${esc(who.display_name || who.id)}
        ${who.provisional ? '<span class="hint" title="machine not yet mapped to a person">provisional</span>' : ''}
        <span class="hint">${esc(who.id)}</span></h2></div>
      <div class="small dim">${t.projects} project${t.projects === 1 ? '' : 's'} ·
        ${t.sessions} sessions (${t.classified_sessions} classified) ·
        ${when(t.first_seen)} → ${when(t.last_seen)}
        ${excluded ? ` · not counted as experience: ${esc(excluded)}` : ''}</div>
      <div class="section">${subhead('Demonstrated capabilities')}${caps || '<span class="dim">none yet</span>'}</div>
    </div>`;
}

/* -------------------------------- liveness -------------------------------- */

// Three states the UI must never conflate: live (the Claude Code process is
// still running, i.e. the terminal tab is open), closed (process gone without a
// SessionEnd), unknown (session predates process-id capture).
const CLOSED_HINT = 'the Claude Code process for this session is gone (tab or window closed)';
const UNKNOWN_HINT = 'this session started before statusline recorded process ids';
const LIVE_TAG = '<span class="live-tag"><span class="live-dot"></span>live</span>';

export function livenessTag(s) {
  if (s.live === true) return ` ${LIVE_TAG}`;
  if (s.end_reason) return '';
  if (s.live === false) return ` <span class="dim small" title="${CLOSED_HINT}">closed</span>`;
  return ` <span class="dim small" title="${UNKNOWN_HINT}">open?</span>`;
}

export function livenessText(s) {
  if (s.end_reason) return `ended (${esc(s.end_reason)})`;
  if (s.live === true) return `${LIVE_TAG} — terminal still open`;
  if (s.live === false) return 'closed — the Claude Code process is gone';
  return 'open (process unknown)';
}

/* --------------------------- classification outlook ------------------------ */

// Renders "what happens to this session next", from the server-computed
// outlook (the scheduler's own rules) rather than guessing client-side.
export function outlookCell(o) {
  if (!o) return '<span class="dim">—</span>';
  const countdown = (prefix) => {
    const ms = new Date(o.due_at).getTime() - Date.now();
    if (ms <= 0) return `${prefix} due — next tick (≤1 min)`;
    return `${prefix} in ~${Math.ceil(ms / 60000)} min if idle`;
  };
  switch (o.kind) {
    case 'queued': return '<span class="ok">queued…</span>';
    case 'pending': return '<span class="ok">classifying now…</span>';
    case 'idle': return countdown('auto');
    case 'recheck': return countdown('re-check');
    case 'upgrade': return countdown('heuristic upgrade');
    case 'waiting_turn': return 'after the first completed turn';
    case 'never': return '<span class="dim">never — empty shell</span>';
    case 'failed': return o.auth
      ? '<span class="bad">needs claude login, then retry</span>'
      : '<span class="bad">retry manually</span>';
    case 'paused_auth': return '<span class="bad">paused — classifier auth failing</span>';
    default: return '<span class="dim">—</span>';
  }
}
