/* Sessions list — the landing view. Answers, per session: what is it, is it
   still open, what state is its classification in, and when does the next one
   fire. */
import { api, esc, when, basename, on, POLL_MS } from '../core.js';
import { stateBadge, projectDot, livenessTag, outlookCell, worktreeBadge } from '../components.js';
import { navigate } from '../router.js';

const SHOW_EMPTY_KEY = 'statusline_show_empty';
const SKILL_TIP_KEY = 'statusline_skill_tip';

// Whether the /statusline skill is linked in, fetched once per page load. This
// list re-renders every few seconds and the answer changes about once ever, so
// polling it would be pure noise.
let skillPromise = null;
function loadSkill() {
  if (!skillPromise)
    skillPromise = api('/api/status')
      .then((s) => s.skill || null)
      .catch(() => null);
  return skillPromise;
}

// Offered once, then never again. An install prompt that cannot be turned off
// is an advert.
function skillTip(skill) {
  if (!skill || skill.installed || localStorage.getItem(SKILL_TIP_KEY) === 'dismissed') return '';
  return `<div class="alert alert-primary d-flex gap-3 align-items-start">
      <div>
        <b>Ask Claude about your own work</b>
        <div class="dim small" style="margin:4px 0 8px">Install the <code>/statusline</code> skill and any Claude Code
          session can answer <i>“what did I work on this week”</i>, <i>“what can I actually claim to know”</i> and
          <i>“why isn’t this session classified”</i> from the data on this page — with the confidence and verification
          caveats attached. It only reads, and nothing leaves this machine.</div>
        <pre>${esc(skill.command)}</pre>
        <div class="dim small" style="margin-top:6px">Run in ${esc(skill.shell)}, then start a new Claude Code session.</div>
      </div>
      <div class="tip-actions">
        <button class="btn btn-outline-secondary btn-sm" data-copy="${esc(skill.command)}">copy</button>
        <button class="btn btn-outline-secondary btn-sm" id="skill-dismiss">dismiss</button>
      </div>
    </div>`;
}

// Resume/branch/compact create session ids that never receive a prompt or tool
// call; these shells are hidden by default.
const isEmpty = (s) => s.counts.prompts === 0 && s.counts.tool_uses === 0;

// Last successful fetch, kept so a transient watcher hiccup shows stale data
// with a warning instead of blanking the page.
let lastFetch = null; // { at: Date, list }

async function loadSessions() {
  try {
    const list = await api('/api/sessions');
    lastFetch = { at: new Date(), list };
    return { list, error: null };
  } catch (e) {
    if (!lastFetch) throw e; // nothing cached — let the router show its error
    return { list: lastFetch.list, error: e.message };
  }
}

function statusbar(list, { error, hiddenEmpty }) {
  const inState = (k) => list.filter((s) => s.classification_state === k).length;
  const inOutlook = (...kinds) => list.filter((s) => kinds.includes(s.outlook?.kind)).length;
  const live = list.filter((s) => s.live === true).length;
  const failed = inState('classification_failed');
  const active = inOutlook('queued', 'pending');
  const awaiting = inOutlook('idle', 'recheck', 'upgrade', 'waiting_turn');

  const parts = [`${list.length} sessions`];
  if (live) parts.push(`${live} live`);
  parts.push(`${inState('classified')} classified`);
  if (active) parts.push(`${active} classifying`);
  if (awaiting) parts.push(`${awaiting} awaiting triggers`);
  if (failed) parts.push(`${failed} failed`);
  if (hiddenEmpty) parts.push(`${hiddenEmpty} empty hidden`);

  const stamp = lastFetch.at.toLocaleTimeString();
  const seconds = POLL_MS / 1000;
  const right = error
    ? `watcher unreachable — retrying every ${seconds}s (showing data from ${esc(stamp)})`
    : `updated ${esc(stamp)} · auto-refreshes every ${seconds}s`;
  return `<div class="statusbar">
      <span class="live-dot${error ? ' err' : ''}"></span>
      <span>${esc(parts.join(' · '))}</span>
      <span class="statusbar-right ${error ? 'bad' : 'dim'}">${right}</span>
    </div>`;
}

function row(s) {
  const c = s.classification;
  const via = c?.via && c.via !== 'claude-cli' ? ` · ${esc(c.via)}` : '';
  const classification = c
    ? `${esc(c.work_type)}<br><span class="dim small">${esc(c.work_category)} · ${esc(c.work_depth)} · ${Math.round(
        c.confidence * 100
      )}%${via}</span>`
    : '<span class="dim">—</span>';
  return `<tr class="rowlink" data-goto="/session/${esc(s.session_id)}">
      <td><code>${esc(s.session_id.slice(0, 8))}</code>${s.label ? `<br><span class="badge text-bg-primary">${esc(s.label)}</span>` : ''}</td>
      <td>${when(s.last_event_at)}<br><span class="dim small">${when(s.created_at)} started</span>${livenessTag(s)}</td>
      <td title="${esc(s.primary_cwd)}">${projectDot(s)}${esc(basename(s.git_root || s.primary_cwd))}${
        s.git_worktree ? ` ${worktreeBadge(s)}` : ''
      }${s.project ? `<br><span class="dim small">→ ${esc(s.project.name)}</span>` : ''}</td>
      <td>${s.counts.turns} turns · ${s.counts.tool_uses} tools</td>
      <td>${stateBadge(s.classification_state)}</td>
      <td class="small">${outlookCell(s.outlook)}</td>
      <td>${classification}</td>
    </tr>`;
}

export async function renderSessions(el) {
  const { list, error } = await loadSessions();
  if (!list.length) {
    el.innerHTML = `<div class="empty">No sessions observed yet.<br><span class="small">Install hooks
      (<code>node src/cli.js install</code>) and use Claude Code — sessions appear here live.</span></div>`;
    return;
  }

  const showEmpty = localStorage.getItem(SHOW_EMPTY_KEY) === '1';
  const emptyCount = list.filter(isEmpty).length;
  const visible = showEmpty ? list : list.filter((s) => !isEmpty(s));
  const toggle = emptyCount
    ? `<div class="mb-2 small dim"><label><input type="checkbox" id="show-empty" ${showEmpty ? 'checked' : ''}>
        show ${emptyCount} empty session${emptyCount === 1 ? '' : 's'} (no prompts, no tools — resume/branch shells)</label></div>`
    : '';

  el.innerHTML = `
    ${skillTip(await loadSkill())}
    ${statusbar(list, { error, hiddenEmpty: showEmpty ? 0 : emptyCount })}
    ${toggle}
    <table class="table table-hover align-top">
      <thead><tr>
        <th>Session</th><th>Activity</th><th>Where</th><th>Volume</th>
        <th>Status</th><th>Next classification</th><th>Classification</th>
      </tr></thead>
      <tbody>${visible.map(row).join('')}</tbody>
    </table>`;

  on('#show-empty', 'change', (cb) => {
    localStorage.setItem(SHOW_EMPTY_KEY, cb.checked ? '1' : '0');
    renderSessions(el);
  });
  on(
    '#skill-dismiss',
    'click',
    () => {
      localStorage.setItem(SKILL_TIP_KEY, 'dismissed');
      renderSessions(el);
    },
    el
  );
  on(
    '[data-copy]',
    'click',
    (b) => {
      navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = 'copied';
    },
    el
  );
  on(
    '[data-goto]',
    'click',
    (tr) => {
      navigate(tr.dataset.goto);
    },
    el
  );
}
