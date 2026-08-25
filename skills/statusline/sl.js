#!/usr/bin/env node
'use strict';
// Read-only query helper for the statusline skill.
//
// Exists because inline `node -e` one-liners are not portable: PowerShell
// strips double quotes out of native-command arguments and shells disagree
// about backslashes, so any snippet containing a Windows path or a JSON string
// silently mangles. A bundled script takes plain arguments and works verbatim
// in PowerShell, cmd and bash.
//
// Built-in Node only, and it never writes anything.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.STATUSLINE_HOME || path.join(os.homedir(), '.statusline');

function port() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    if (cfg && Number.isInteger(cfg.port)) return cfg.port;
  } catch (e) {
    /* default below */
  }
  return 45817;
}

const BASE = `http://127.0.0.1:${port()}`;

async function api(p) {
  let res;
  try {
    res = await fetch(BASE + p);
  } catch (e) {
    console.error(`statusline is not answering on ${BASE} — the watcher is not running.`);
    console.error(
      `Start it with: node <repo>/src/cli.js start   (lock file: ${path.join(HOME, 'watcher.lock')})`
    );
    process.exit(3);
  }
  if (!res.ok) {
    console.error(`${p} → HTTP ${res.status}`);
    process.exit(4);
  }
  return res.json();
}

const pad = (v, n) =>
  String(v === null || v === undefined ? '-' : v)
    .slice(0, n)
    .padEnd(n);
const day = (ts) => (ts ? String(ts).slice(0, 10) : '-');

// Where the agent lives. Two independent sources, because the interesting case
// is a watcher that is NOT running: agent.json is written by every cli.js
// command and by hook-forward on SessionStart, while the hook command in
// settings.json only exists for clone installs (a plugin registers its hooks
// through the plugin manifest instead).
function repoFrom(hookCommand) {
  const m = /"(.+)[/\\]hooks[/\\]hook-forward/.exec(hookCommand || '');
  return m ? m[1] : null;
}

function recordedAgentRoot() {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8'));
    return typeof rec.root === 'string' ? rec.root : null;
  } catch (e) {
    return null;
  }
}

const commands = {
  async status() {
    const s = await api('/api/status');
    const missing = s.installer.entries.filter((e) => !e.installed);
    console.log(`data dir     ${s.data_dir}`);
    console.log(
      `agent        ${recordedAgentRoot() || repoFrom(s.installer.hookCommand) || '(unknown)'}`
    );
    console.log(`sessions     ${s.sessions}`);
    console.log(`spool        ${s.spool.pending} pending, ${s.spool.quarantined} quarantined`);
    console.log(
      `hooks        ${s.installer.entries.length - missing.length}/${s.installer.entries.length} installed` +
        (missing.length
          ? ` — MISSING: ${missing.map((e) => e.event).join(', ')} (run: node <repo>/src/cli.js install)`
          : '')
    );
    const q = s.scheduler || {};
    console.log(
      `scheduler    queued=${q.queued ?? '-'} running=${q.running ?? '-'} classified=${q.classified ?? '-'} failed=${q.failed ?? '-'}` +
        (q.auth_backoff_until ? `  AUTH BACKOFF until ${q.auth_backoff_until}` : '')
    );
    console.log(`machine_id   ${s.machine_id || '(none — uploads never enabled)'}`);
  },

  async sessions(daysArg) {
    const days = Number(daysArg) > 0 ? Number(daysArg) : 14;
    const cutoff = Date.now() - days * 86400000;
    const all = await api('/api/sessions');
    const rows = all.filter((s) => Date.parse(s.last_event_at) >= cutoff);
    console.log(`${rows.length} of ${all.length} session(s) active in the last ${days} day(s)\n`);
    console.log(
      `${pad('LAST', 10)} ${pad('STATE', 14)} ${pad('PROJECT', 18)} ${pad('TURNS', 5)} WORK`
    );
    for (const s of rows) {
      const c = s.classification;
      const note = c ? c.work_type : s.outlook && s.outlook.kind ? `(${s.outlook.kind})` : '';
      const flag = s.label ? ` [${s.label}]` : '';
      console.log(
        `${pad(day(s.last_event_at), 10)} ${pad(s.classification_state, 14)} ${pad(s.project && s.project.name, 18)} ${pad(s.counts.turns, 5)} ${note}${flag}`
      );
    }
    const unclassified = rows.filter((s) => s.classification_state !== 'classified');
    if (unclassified.length)
      console.log(`\n${unclassified.length} not classified — their work is NOT described above.`);
  },

  async session(sid) {
    if (!sid) return usage('session <session-id>');
    const s = await api(`/api/sessions/${encodeURIComponent(sid)}`);
    if (s.error) return console.error(s.error);
    const c = s.classification_effective || s.classification || {};
    console.log(`session      ${s.session_id}`);
    console.log(`cwd          ${s.primary_cwd || '-'}`);
    console.log(
      `git          ${s.git_root || '-'}${s.git_worktree ? ` (worktree ${s.git_worktree})` : ''}`
    );
    // `live` means the owning Claude Code process still exists — not that the
    // session is active. An open terminal from yesterday still reads as live.
    console.log(
      `window       ${s.created_at} → ${s.last_event_at}${s.live ? '  (host process still running)' : ''}`
    );
    console.log(`counts       ${JSON.stringify(s.counts)}`);
    console.log(
      `state        ${s.classification_state}${s.classifier_error ? ` — ${s.classifier_error}` : ''}   idle_minutes=${s.idle_minutes}`
    );
    if (Object.keys(c).length) {
      console.log(
        `category     ${c.work_category}  depth=${c.work_depth}  confidence=${c.confidence}`
      );
      console.log(`work_type    ${c.work_type || '-'}`);
      console.log(
        `technologies ${(c.technologies || []).map((t) => (t.name || t) + (t.evidence ? `(${t.evidence}${t.verified ? '' : '?'})` : '')).join(', ') || '-'}`
      );
    }
    const meta = s.classification && s.classification._meta;
    if (meta)
      console.log(
        `classifier   ${meta.classifier || '-'}  ${meta.model || ''} ${meta.cost_usd ? `$${meta.cost_usd}` : ''}`
      );
    if (s.correction) console.log(`correction   ${JSON.stringify(s.correction)}`);
  },

  async experience() {
    const e = await api('/api/experience');
    const p = e.practitioners && e.practitioners[0];
    if (!p) return console.log('no experience computed yet');
    const t = p.totals;
    console.log(
      `${t.projects} project(s), ${t.classified_sessions}/${t.sessions} sessions classified, ${day(t.first_seen)} → ${day(t.last_seen)}`
    );
    console.log(`excluded: ${JSON.stringify(t.excluded)}  (earns no capability credit)`);
    if (t.industries && t.industries.length) console.log(`industries: ${t.industries.join(', ')}`);

    // The headline axis: business capabilities (catalog picks). "grounded" =
    // the session activity behind the claim is tool-verified; the business
    // reading is the classifier's judgment, so it is never called "verified".
    const bcaps = p.business_capabilities || [];
    console.log(`\nBUSINESS CAPABILITIES — what problems this work solves`);
    if (!bcaps.length) {
      console.log('  none yet (sessions classified by client <0.3.0 carry no catalog picks)');
    } else {
      console.log(
        `${pad('CAPABILITY', 42)} ${pad('PROJECTS', 8)} ${pad('GROUNDED', 8)} FIRST → LAST`
      );
      for (const c of bcaps) {
        const sessions = (c.projects || []).reduce((n, x) => n + x.sessions, 0);
        const warn =
          sessions === 1
            ? '  ← provisional (1 session)'
            : c.grounded_projects === 0
              ? '  ← claimed, no tool corroboration'
              : c.uncertainty && c.uncertainty.any_heuristic
                ? '  ← heuristic'
                : '';
        console.log(
          `${pad(c.name, 42)} ${pad(c.distinct_projects, 8)} ${pad(c.grounded_projects, 8)} ${day(c.first_used)} → ${day(c.last_used)}${warn}`
        );
      }
    }

    console.log(`\nTECHNOLOGIES (supporting facet)`);
    console.log(
      `${pad('TECHNOLOGY', 22)} ${pad('PROJECTS', 8)} ${pad('VERIFIED', 8)} ${pad('EVIDENCE', 12)} FIRST → LAST`
    );
    for (const c of p.capabilities) {
      const warn =
        c.verified_projects === 0
          ? '  ← unverified'
          : c.uncertainty && c.uncertainty.any_heuristic
            ? '  ← heuristic'
            : '';
      console.log(
        `${pad(c.name, 22)} ${pad(c.distinct_projects, 8)} ${pad(c.verified_projects, 8)} ${pad(c.max_evidence, 12)} ${day(c.first_used)} → ${day(c.last_used)}${warn}`
      );
    }
  },

  async projects() {
    const g = await api('/api/projects');
    // Singletons are catch-all home-dir / no-cwd sessions. They are never real
    // projects and all of them together earn at most one credit — keep them out
    // of the main table so they cannot be mistaken for engagements.
    const real = g.projects.filter((p) => !p.singleton);
    const singles = g.projects.length - real.length;
    console.log(
      `${real.length} project(s)${singles ? ` (+${singles} miscellaneous singleton session(s), not counted as projects)` : ''}\n`
    );
    console.log(
      `${pad('ID', 16)} ${pad('NAME', 24)} ${pad('SESS', 5)} ${pad('KIND', 10)} ${pad('ENGAGEMENT', 14)} LAST`
    );
    for (const p of real) {
      const a = p.aggregate || {};
      console.log(
        `${pad(p.id, 16)} ${pad(p.name, 24)} ${pad(p.session_ids ? p.session_ids.length : '-', 5)} ${pad(p.key && p.key.kind, 10)} ${pad(p.engagement_id, 14)} ${day(a.last_seen)}`
      );
    }
    const merges = g.projects.flatMap((p) =>
      (p.suggested_merges || []).map((m) => ({ from: p.id, ...m }))
    );
    if (merges.length) {
      console.log(`\n${merges.length} merge suggestion(s):`);
      for (const m of merges)
        console.log(
          `  ${m.from} + ${m.project_id || m.other || m.id}  score=${m.score}  ${(m.reasons || []).join(', ')}`
        );
    }
  },

  async egress(n) {
    const rows = (await api('/api/egress'))
      .slice()
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const take = Number(n) > 0 ? Number(n) : 20;
    const failed = rows.filter((r) => r.outcome && r.outcome !== 'ok');
    console.log(
      `${rows.length} recent attempt(s), ${failed.length} not ok; newest ${rows.length ? rows[rows.length - 1].at : '-'}\n`
    );
    console.log(
      `${pad('AT', 24)} ${pad('KIND', 10)} ${pad('OUTCOME', 10)} ${pad('HTTP', 5)} DETAIL`
    );
    for (const r of rows.slice(-take)) {
      const detail = [
        r.endpoint_host,
        r.session_count !== undefined ? `${r.session_count} session(s)` : null,
        r.error || r.reason,
      ]
        .filter(Boolean)
        .join('  ');
      console.log(
        `${pad(r.at, 24)} ${pad(r.kind, 10)} ${pad(r.outcome, 10)} ${pad(r.http_status, 5)} ${detail}`
      );
    }
  },

  async repo() {
    // Answer without the API when possible: this is the command you reach for
    // when the watcher is down and you need the path to cli.js.
    const recorded = recordedAgentRoot();
    if (recorded) return void console.log(recorded);
    const s = await api('/api/status');
    const r = repoFrom(s.installer.hookCommand);
    if (!r) {
      console.error(
        'could not locate the agent — nothing recorded in agent.json and no hook command to read it from'
      );
      process.exit(5);
    }
    console.log(r);
  },

  async api(p) {
    if (!p) return usage('api /api/<path>');
    console.log(JSON.stringify(await api(p.startsWith('/') ? p : '/' + p), null, 2));
  },
};

function usage(extra) {
  console.error('usage: node sl.js <command>\n');
  console.error('  status              capture health: hooks, spool, scheduler, repo path');
  console.error(
    '  sessions [days]     one line per session active in the last N days (default 14)'
  );
  console.error('  session <sid>       full detail for one session');
  console.error('  experience          capabilities by distinct project, with verification');
  console.error('  projects            project grouping + merge suggestions');
  console.error('  egress [n]          last n network attempts (classifier calls and uploads)');
  console.error('  repo                path to the statusline checkout');
  console.error('  api <path>          raw JSON from any endpoint');
  if (extra) console.error(`\nexpected: ${extra}`);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) usage();
commands[cmd](...rest).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
