/* Session detail — the full record for one session: what was asked, what the
   classifier concluded and why, and exactly what text was (or would be) sent. */
import { api, esc, when, basename, minutesSince, sessionUrl, csv, on } from '../core.js';
import { render, pauseRefresh } from '../router.js';
import {
  stateBadge,
  badge,
  banner,
  metaGrid,
  subhead,
  techChips,
  confidenceBar,
  livenessText,
  costNote,
  worktreeBadge,
} from '../components.js';

const LABELS = ['client_work', 'internal_work', 'learning', 'personal', 'ignore'];
const CATEGORIES = ['client_work', 'internal_work', 'learning', 'personal', 'unknown'];
const STAGES = ['research', 'planning', 'implementation', 'debugging', 'review', 'analysis', 'writing', 'configuration', 'operations', 'other', 'unknown'];
const DEPTHS = ['substantive', 'shallow', 'trivial'];
const PROMPT_CAP = 10; // prompts shown before the "show N more" expander
const EVENTS_CAP = 60000; // chars of raw event JSON rendered

/* --------------------------------- header --------------------------------- */

// What the session WAS, not its hex id: the classified work type when we have
// one, otherwise the opening prompt.
function titleFor(s, cls, sid) {
  if (cls?.work_type && cls.work_type !== 'unknown') {
    return cls.work_type + (cls.project_hint ? ` — ${cls.project_hint}` : '');
  }
  const first = s.prompts?.[0]?.text.replace(/\s+/g, ' ').trim();
  if (!first) return `Session ${sid.slice(0, 8)}`;
  return first.slice(0, 90) + (first.length > 90 ? '…' : '');
}

/* ------------------------------ classification ----------------------------- */

function failureBanner(s) {
  const auth = /auth_error/.test(s.classifier_error || '');
  const hint = auth ? '<br><b>Hint:</b> run <code>claude</code> in a terminal and log in, then retry.' : '';
  return banner(`Classification failed: ${esc(s.classifier_error)}${hint}`, 'error');
}

// Why this classification exists in the form it does — inherited, degraded, or
// superseded by newer activity.
function provenanceBanners(s, cls) {
  const meta = cls._meta || {};
  const out = [];
  if (meta.classifier === 'inherited') {
    out.push(
      banner(`Inherited from session <code>${esc((meta.inherited_from || '').slice(0, 8))}</code>
        (continuation — no classifier call). Use Re-classify for a fresh LLM classification.`)
    );
  }
  if (meta.classifier === 'heuristic') {
    out.push(
      banner(`Heuristic fallback — the classifier was unreachable (${esc(meta.fallback_reason || 'error')}).
        Low confidence; will be upgraded automatically when the classifier is reachable.`, 'error')
    );
  }
  if (s.classification_state === 'stale') {
    out.push(banner('New activity since this classification — it will re-classify automatically when the session goes idle.'));
  }
  return out.join('');
}

function classifiedHtml(s, cls, corr) {
  const meta = cls._meta || {};
  return `
    ${provenanceBanners(s, cls)}
    <div class="cls-summary">
      ${badge(cls.work_category.replace('_', ' '), 'cat')}
      <span class="cls-worktype">${esc(cls.work_type)}</span>
      <span class="dim">${esc(cls.work_stage)} · ${esc(cls.work_depth)}</span>
      ${confidenceBar(cls.confidence)}
    </div>
    ${metaGrid([
      ['Professional work', cls.professional_work ? 'yes' : 'no'],
      ['Industry', esc((cls.industry || []).join(', '))],
      ['Business function', esc((cls.business_function || []).join(', '))],
      ['Artifacts', esc((cls.artifacts || []).join(', '))],
      ['Project hint', `${esc(cls.project_hint)} ${cls.continuation ? badge('continuation') : ''}`],
    ])}
    <div class="section">${subhead('Tasks')}${
      (cls.tasks || []).map((t) => `<span class="chip task">${esc(t)}</span>`).join('') || '<span class="dim">—</span>'
    }</div>
    <div class="section">${subhead('Technologies — hover a chip for the evidence basis')}${
      techChips(cls.technologies) || '<span class="dim">—</span>'
    }</div>
    ${cls.rationale ? `<div class="rationale">“${esc(cls.rationale)}”</div>` : ''}
    ${corr.field_overrides ? '<div class="note">⚠ includes your manual field overrides</div>' : ''}
    <div class="note">${esc(meta.classifier || 'classifier')}${meta.model ? ` (${esc(meta.model)}${meta.effort ? `, ${esc(meta.effort)} effort` : ''})` : ''} ·
      ${when(meta.classified_at || s.classified_at)} · attempt(s) ${esc(meta.attempts)}${
        meta.trigger ? ` · trigger: ${esc(meta.trigger)}` : ''
      }${costNote(meta)}</div>`;
}

// Unclassified sessions get a real answer to "when will this classify?".
function waitingHtml(s) {
  if (s.counts.turns < 1) {
    const why = s.counts.prompts === 0 ? ' (no prompts captured; resume/branch shells never classify)' : '';
    return `<div class="dim">Not classified — waiting for the first completed turn${why}.</div>`;
  }
  const threshold = s.idle_minutes || 10;
  const idleFor = Math.max(0, minutesSince(s.last_event_at));
  const remaining = Math.ceil(threshold - idleFor);
  if (remaining > 0) {
    return `<div class="dim">Not classified yet — auto-classifies once the session has been idle ${threshold} min
      (idle ${Math.floor(idleFor)} min now, ~${remaining} min to go) or when it ends.
      <b>Classify now</b> above runs it immediately.</div>`;
  }
  return `<div class="dim">Not classified yet — idle threshold reached; the scheduler picks it up within a minute.
    Or use <b>Classify now</b> above.</div>`;
}

function classificationHtml(s, cls, corr) {
  // A failed re-classification keeps the previous result visible, with the
  // error above it — the badge alone would not say what went wrong.
  const failure = s.classification_state === 'classification_failed' ? failureBanner(s) : '';
  if (cls) return failure + classifiedHtml(s, cls, corr);
  if (failure) return failure;
  if (s.classification_state === 'pending') return '<div class="dim">Classification in progress…</div>';
  return waitingHtml(s);
}

/* ---------------------------------- cards --------------------------------- */

const promptItem = (p, cls = '') =>
  `<div class="prompt-item ${cls}"><div class="when">${when(p.at)}</div>${esc(p.text)}${
    p.omitted_chars ? ` <span class="dim">[+${p.omitted_chars} chars truncated]</span>` : ''
  }</div>`;

function promptsHtml(s) {
  const all = s.prompts || [];
  if (!all.length) return '<div class="dim">none captured</div>';
  const shown = all.slice(0, PROMPT_CAP).map((p) => promptItem(p)).join('');
  if (all.length <= PROMPT_CAP) return shown;
  return `${shown}<details><summary class="dim small">show ${all.length - PROMPT_CAP} more prompts</summary>${all
    .slice(PROMPT_CAP)
    .map((p) => promptItem(p))
    .join('')}</details>`;
}

function toolActivityHtml(s) {
  if (s.counts.tool_uses === 0) return '<div class="dim">No tool usage — conversation only.</div>';
  const t = s.tools || {};
  const histogram = (obj) => Object.entries(obj || {}).map(([k, n]) => `${k}×${n}`).join(', ');
  const list = (label, items) =>
    (items || []).length
      ? `<details><summary>${items.length} ${label}</summary><pre>${esc(items.join('\n'))}</pre></details>`
      : '';
  return `
    ${metaGrid([
      ['Tool counts', esc(histogram(t.by_name))],
      ['MCP servers', esc((t.mcp_servers || []).join(', '))],
      ['Extensions', esc(histogram(t.extensions))],
      ['Dependencies', esc((t.dependencies_observed || []).join(', '))],
    ])}
    ${list('shell commands', t.bash_commands)}
    ${list('files touched', t.files_touched)}`;
}

function digestHtml(s) {
  if (!s.digest) return '<div class="dim">No digest built yet (nothing has been sent for this session).</div>';
  return `<div class="small dim">built ${when(s.digest.built_at)} · ${s.digest.chars} chars ·
      sha256 <code>${esc((s.digest.sha256 || '').slice(0, 16))}…</code></div>
    <details><summary>show exactly what ${s.classification ? 'was' : 'will be'} sent</summary>
      <pre>${esc(s.digest.text)}</pre></details>`;
}

/* ---------------------------------- view ---------------------------------- */

export async function renderSession(el, sid) {
  const [s, projects] = await Promise.all([api(sessionUrl(sid)), api('/api/projects')]);
  const cls = s.classification_effective;
  const corr = s.correction || {};

  const projOptions = ['<option value="">(auto-grouped)</option>']
    .concat(
      projects.projects.map(
        (p) => `<option value="${esc(p.id)}" ${corr.project_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
      )
    )
    .join('');

  const excerpts = (s.assistant_excerpts || []).map((e) => promptItem(e, 'assistant')).join('');
  const subagents = s.counts.subagent_events ? ` · ${s.counts.subagent_events} subagent events` : '';

  el.innerHTML = `
    <p><a href="/sessions">← all sessions</a></p>
    <div class="card">
      <h2>${esc(titleFor(s, cls, sid))} ${stateBadge(s.classification_state)}</h2>
      <div class="dim small mb-2">session <code>${esc(sid.slice(0, 8))}</code> ·
        ${esc(basename(s.git_root || s.primary_cwd))} ${worktreeBadge(s)}</div>
      ${metaGrid([
        ['Directory', `<span title="${esc(s.primary_cwd)}">${esc(s.primary_cwd)}</span>`],
        ['Git repo', esc(s.git_root)],
        s.git_worktree && ['Worktree', esc(s.git_worktree)],
        ['Started / last', `${when(s.created_at)} / ${when(s.last_event_at)}`],
        ['Status', livenessText(s)],
        ['Volume', `${s.counts.prompts} prompts · ${s.counts.turns} turns · ${s.counts.tool_uses} tool calls${subagents}`],
      ])}
      <div class="controls-row section">
        ${subhead('Label:')}
        ${LABELS.map((l) => `<button class="btn ${corr.label === l ? 'active' : ''}" data-label="${l}">${l.replace('_', ' ')}</button>`).join('')}
        ${corr.label ? '<button class="btn btn-outline-danger btn-sm" data-label="">clear</button>' : ''}
        <span class="spacer"></span>
        ${subhead('Project:')}
        <select class="form-select form-select-sm" id="projSel">${projOptions}</select>
      </div>
      <div class="controls-row section">
        <button class="btn btn-primary btn-sm" id="btnClassify">${s.classification ? 'Re-classify' : 'Classify now'} (1 LLM call)</button>
        <button class="btn btn-outline-secondary btn-sm" id="btnDigest">Preview digest</button>
        <button class="btn btn-outline-secondary btn-sm" id="btnOverrides">Correct fields</button>
      </div>
      <div id="digestBox"></div>
      <div id="overridesBox"></div>
    </div>
    <div class="card"><h2>Classification <span class="hint">why: hover technology chips; rationale below</span></h2>
      ${classificationHtml(s, cls, corr)}</div>
    <div class="card"><h2>Prompts</h2>${promptsHtml(s)}</div>
    ${excerpts
      ? `<div class="card"><h2>Assistant <span class="hint">best-effort excerpts from the local transcript,
          captured at classification time</span></h2>${excerpts}</div>`
      : ''}
    <div class="card"><h2>Tool activity</h2>${toolActivityHtml(s)}</div>
    <div class="card"><h2>Digest sent</h2>${digestHtml(s)}</div>
    <details class="card"><summary>Raw events (${(s.events || []).length})</summary>
      <pre>${esc(JSON.stringify(s.events, null, 1).slice(0, EVENTS_CAP))}</pre></details>`;

  on('[data-label]', 'click', async (btn) => {
    await api(sessionUrl(sid, '/label'), 'POST', { label: btn.dataset.label || null });
    render();
  });
  on('#projSel', 'change', async (sel) => {
    await api(sessionUrl(sid, '/project'), 'POST', { project_id: sel.value || null });
    render();
  });
  on('#btnClassify', 'click', async () => {
    await api(sessionUrl(sid, '/classify'), 'POST', {});
    render();
  });
  on('#btnDigest', 'click', async () => {
    const box = document.getElementById('digestBox');
    box.innerHTML = '<div class="dim small">building preview…</div>';
    const d = await api(sessionUrl(sid, '/digest'));
    box.innerHTML = `<div class="note">${d.chars} chars · preview only — nothing sent</div><pre>${esc(d.text)}</pre>`;
  });
  on('#btnOverrides', 'click', () => renderOverridesEditor(sid, cls, corr));
}

/* ----------------------------- overrides editor ---------------------------- */

function renderOverridesEditor(sid, cls, corr) {
  pauseRefresh(true);
  const ov = corr.field_overrides || {};
  const value = (field, fallback) => (ov[field] !== undefined ? ov[field] : cls ? cls[field] : fallback);
  const asText = (x) => (Array.isArray(x) ? x.join(', ') : x || '');
  const text = (field, label) =>
    `<div class="field"><label>${label}</label><input type="text" class="form-control form-control-sm" name="${field}" value="${esc(asText(value(field, '')))}"></div>`;
  const select = (field, options, fallback) =>
    `<div class="field"><label>${field}</label><select class="form-select form-select-sm" name="${field}">${options
      .map((o) => `<option ${o === String(value(field, fallback)) ? 'selected' : ''}>${o}</option>`)
      .join('')}</select></div>`;

  document.getElementById('overridesBox').innerHTML = `
    <div class="card section">
      <h2>Correct classification fields <span class="hint">saved corrections always win over the classifier</span></h2>
      <form id="ovForm" class="grid2">
        ${select('work_category', CATEGORIES, 'unknown')}
        ${text('work_type', 'work_type')}
        ${text('industry', 'industry (comma-separated)')}
        ${text('business_function', 'business_function (comma-separated)')}
        ${text('tasks', 'tasks (comma-separated)')}
        ${select('work_stage', STAGES, 'unknown')}
        ${select('work_depth', DEPTHS, 'shallow')}
        ${select('professional_work', ['true', 'false'], false)}
      </form>
      <div class="controls-row">
        <button class="btn btn-primary btn-sm" id="ovSave">Save corrections</button>
        <button class="btn btn-outline-secondary btn-sm" id="ovCancel">Cancel</button>
      </div>
    </div>`;

  on('#ovCancel', 'click', () => {
    pauseRefresh(false);
    render();
  });
  on('#ovSave', 'click', async () => {
    const f = new FormData(document.getElementById('ovForm'));
    await api(sessionUrl(sid, '/overrides'), 'POST', {
      field_overrides: {
        work_category: f.get('work_category'),
        work_type: f.get('work_type'),
        industry: csv(f.get('industry')),
        business_function: csv(f.get('business_function')),
        tasks: csv(f.get('tasks')),
        work_stage: f.get('work_stage'),
        work_depth: f.get('work_depth'),
        professional_work: f.get('professional_work') === 'true',
      },
    });
    pauseRefresh(false);
    render();
  });
}
