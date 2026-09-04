/* Projects — sessions grouped by repo/directory, with the capabilities each
   group demonstrates and any merge suggestions the grouper produced. */
import { api, esc, when, on } from '../core.js';
import { banner, subhead } from '../components.js';
import { render } from '../router.js';

function capabilityChips(aggregate) {
  const chips = [];
  for (const info of aggregate.technologies || []) {
    // "mentioned" is too weak to read as a capability.
    if (info.max_evidence !== 'mentioned') {
      // Same convention as session chips: a hands_on with zero tool-verified
      // sessions renders dashed with "?" — classifier claim, not evidence.
      const unverified = info.max_evidence === 'hands_on' && !(info.verified_sessions > 0);
      const title = `${info.sessions} session(s), ${info.verified_sessions || 0} tool-verified${unverified ? ' — claimed by classifier, no tool evidence' : ''}`;
      chips.push(
        `<span class="chip ${info.max_evidence}${unverified ? ' unverified' : ''}" title="${esc(title)}">${esc(info.name || info.canonical)}${unverified ? '?' : ''}</span>`
      );
    }
  }
  for (const l of aggregate.tasks_recent || [])
    chips.push(`<span class="chip task" title="${esc(when(l.at))}">${esc(l.text)}</span>`);
  for (const ind of aggregate.industries || [])
    chips.push(`<span class="chip industry">${esc(ind)}</span>`);
  return chips.join('') || '<span class="dim">none yet</span>';
}

function sessionLine(sid, s) {
  const detail = s
    ? `${when(s.last_event_at)} — ${esc(s.classification ? s.classification.work_type : s.classification_state)}`
    : '';
  return `<div>· <a href="/session/${esc(sid)}"><code>${esc(sid.slice(0, 8))}</code></a>
    <span class="dim small">${detail}</span></div>`;
}

function mergeSuggestions(p) {
  return (p.suggested_merges || [])
    .map((m) =>
      banner(`Looks similar to <b>${esc(m.project_name)}</b> (score ${m.score}; ${esc(m.reasons.join(', '))}).
        <button class="btn btn-outline-secondary btn-sm" data-merge-from="${esc(p.id)}" data-merge-into="${esc(m.project_id)}">Merge into it</button>
        <button class="btn btn-outline-secondary btn-sm" data-dismiss-a="${esc(p.id)}" data-dismiss-b="${esc(m.project_id)}">Dismiss</button>`)
    )
    .join('');
}

function projectCard(p, bySid) {
  const agg = p.aggregate;
  const votes = Object.entries(agg.work_category_votes)
    .map(([k, n]) => `${k}×${n}`)
    .join(', ');
  const engBadge = p.engagement_id
    ? ` <span class="chip industry" title="declared engagement ${esc(p.engagement_id)}">${esc(p.engagement_kind || 'engagement')}</span>`
    : '';
  return `<div class="card">
      <div class="proj-head">
        <h2>${esc(p.name)}${engBadge} <span class="hint">${esc(p.key.kind)}: ${esc(p.key.value)}</span></h2>
        <button class="btn btn-outline-secondary btn-sm" data-rename="${esc(p.id)}" data-name="${esc(p.name)}">rename</button>
      </div>
      ${mergeSuggestions(p)}
      <div class="small dim">${agg.total_sessions} sessions (${agg.classified_sessions} classified) ·
        ${when(agg.first_seen)} → ${when(agg.last_seen)} · categories: ${esc(votes) || '—'}</div>
      <div class="section">${subhead('Detected capabilities')}${capabilityChips(agg)}</div>
      <details open><summary>Sessions</summary>${p.session_ids.map((sid) => sessionLine(sid, bySid.get(sid))).join('')}</details>
    </div>`;
}

// Singletons (home-dir / no-cwd sessions) are not projects: they render as one
// collapsed miscellaneous list so counts and capabilities stay honest.
function miscCard(singles) {
  const lines = singles
    .map((p) => {
      const sid = p.session_ids[0];
      return `<div>· <a href="/session/${esc(sid)}"><code>${esc(sid.slice(0, 8))}</code></a>
        <span class="dim small">${esc(p.name !== p.id ? p.name : '')}</span></div>`;
    })
    .join('');
  return `<div class="card">
      <div class="proj-head"><h2>Miscellaneous sessions <span class="hint">${singles.length} not part of any project</span></h2></div>
      <div class="small dim">Sessions from catch-all directories. Assign one to a project from its session page.</div>
      <details><summary>Sessions</summary>${lines}</details>
    </div>`;
}

export async function renderProjects(el) {
  const [data, sessions] = await Promise.all([api('/api/projects'), api('/api/sessions')]);
  if (!data.projects.length) {
    el.innerHTML =
      '<div class="empty">No projects yet — they appear once sessions are observed.</div>';
    return;
  }
  const bySid = new Map(sessions.map((s) => [s.session_id, s]));
  const real = data.projects.filter((p) => !p.singleton);
  const singles = data.projects.filter((p) => p.singleton);
  el.innerHTML =
    real.map((p) => projectCard(p, bySid)).join('') + (singles.length ? miscCard(singles) : '');

  on('[data-rename]', 'click', async (b) => {
    const name = prompt('Project name:', b.dataset.name);
    if (!name) return;
    await api(`/api/projects/${b.dataset.rename}/rename`, 'POST', { name });
    render();
  });
  on('[data-merge-from]', 'click', async (b) => {
    await api(`/api/projects/${b.dataset.mergeFrom}/merge`, 'POST', { into: b.dataset.mergeInto });
    render();
  });
  on('[data-dismiss-a]', 'click', async (b) => {
    await api(`/api/projects/${b.dataset.dismissA}/dismiss-merge`, 'POST', {
      other: b.dataset.dismissB,
    });
    render();
  });
}
