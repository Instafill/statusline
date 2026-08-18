'use strict';
// JSON API route handlers. Everything is read from / written to local state;
// the only route with egress side-effects is POST classify (queues a
// classifier run, which is itself egress-logged).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../paths');
const config = require('../config');
const sessions = require('../watcher/sessions');
const grouping = require('../grouping');
const egress = require('../classify/egress');
const installer = require('../installer');
const { buildDigest } = require('../digest');
const { readAssistantExcerpts } = require('../watcher/transcript');
const { liveness, classificationOutlook } = require('../session-view');
const { computeExperience } = require('../experience-core');

function sessionSummary(s, corrections, projectsById) {
  const corr = corrections.sessions[s.session_id] || {};
  const cls = grouping.effectiveClassification(s, corrections);
  let project = null;
  for (const p of projectsById.values()) {
    if (p.session_ids.includes(s.session_id)) {
      project = { id: p.id, name: p.name };
      break;
    }
  }
  return {
    session_id: s.session_id,
    created_at: s.created_at,
    last_event_at: s.last_event_at,
    primary_cwd: s.primary_cwd,
    git_root: s.git_root,
    git_worktree: s.git_worktree || null,
    end_reason: s.end_reason,
    live: liveness(s),
    counts: s.counts,
    classification_state: s.classification_state,
    classifier_error: s.classifier_error || null,
    label: corr.label || null,
    project,
    classification: cls
      ? {
          professional_work: cls.professional_work,
          work_category: cls.work_category,
          work_type: cls.work_type,
          work_depth: cls.work_depth,
          confidence: cls.confidence,
          project_hint: cls.project_hint,
          via: (cls._meta && cls._meta.classifier) || null, // claude-cli | inherited | heuristic
        }
      : null,
  };
}

function createApi({ scheduler, startedAt }) {
  const routes = {};

  const projectsIndex = () => {
    const map = new Map();
    for (const p of grouping.getProjects().projects) map.set(p.id, p);
    return map;
  };

  routes['GET /api/health'] = () => ({ ok: true, pid: process.pid, started_at: startedAt, app: 'statusline' });

  // The /statusline skill is opt-in and installed by linking a directory, so
  // the only way to know whether someone has it is to look. Existence only —
  // nothing under ~/.claude is ever read. The UI uses this to offer the
  // one-liner exactly once and then stop asking.
  function skillStatus() {
    const source = path.join(__dirname, '..', '..', 'skills', 'statusline');
    const link = path.join(os.homedir(), '.claude', 'skills', 'statusline');
    let installed = false;
    try {
      installed = fs.existsSync(path.join(link, 'SKILL.md'));
    } catch (e) {
      /* treat an unreadable path as not installed */
    }
    const command =
      process.platform === 'win32'
        ? `New-Item -ItemType Directory -Force "$env:USERPROFILE\\.claude\\skills" > $null; New-Item -ItemType Junction -Path "$env:USERPROFILE\\.claude\\skills\\statusline" -Target "${source}"`
        : `mkdir -p ~/.claude/skills && ln -s "${source}" ~/.claude/skills/statusline`;
    return { installed, source, link, command, shell: process.platform === 'win32' ? 'PowerShell' : 'shell' };
  }

  routes['GET /api/status'] = () => {
    let spoolDepth = 0;
    let quarantineDepth = 0;
    try {
      spoolDepth = fs.readdirSync(paths.spoolNew).length;
      quarantineDepth = fs.readdirSync(paths.spoolQuarantine).length;
    } catch (e) {
      /* ignore */
    }
    // machine_id backs the Settings enrollment panel (lazy-created UUID —
    // harmless when uploads are off, required once they are on).
    let machineId = null;
    try {
      machineId = require('../upload/identity').machineIdentity().machine_id;
    } catch (e) {
      /* leave null */
    }
    return {
      installer: installer.status(),
      scheduler: scheduler.stats(),
      spool: { pending: spoolDepth, quarantined: quarantineDepth },
      sessions: sessions.listSessions().length,
      data_dir: paths.home,
      machine_id: machineId,
      skill: skillStatus(),
    };
  };

  routes['GET /api/sessions'] = () => {
    const corrections = grouping.loadCorrections();
    const projs = projectsIndex();
    const cfg = config.load();
    const sched = scheduler.stats();
    return sessions.listSessions().map((s) => ({
      ...sessionSummary(s, corrections, projs),
      outlook: classificationOutlook(s, cfg, sched),
    }));
  };

  routes['GET /api/sessions/:id'] = (params) => {
    const s = sessions.getSession(params.id);
    if (!s) return { _status: 404, error: 'unknown session' };
    const corrections = grouping.loadCorrections();
    return {
      ...s,
      live: liveness(s),
      digest: s.digest ? { ...s.digest, text: s.digest.text } : null,
      classification_effective: grouping.effectiveClassification(s, corrections),
      correction: corrections.sessions[s.session_id] || null,
      events: sessions.getEvents(params.id, 200),
      idle_minutes: config.load().idle_minutes, // so the UI can say when auto-classification will fire
    };
  };

  // Fresh digest preview — no egress, no state transition.
  routes['GET /api/sessions/:id/digest'] = (params) => {
    const s = sessions.foldSession(params.id) || sessions.getSession(params.id);
    if (!s) return { _status: 404, error: 'unknown session' };
    const cfg = config.load();
    const excerpts = s.transcript_path
      ? readAssistantExcerpts(s.transcript_path, {
          maxExcerpts: cfg.digest.max_excerpts,
          maxExcerptChars: cfg.digest.max_excerpt_chars,
        })
      : [];
    const text = buildDigest({ ...s, assistant_excerpts: excerpts }, cfg.digest);
    return { text, chars: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex'), note: 'preview only — nothing was sent' };
  };

  routes['POST /api/sessions/:id/classify'] = (params) => {
    if (!sessions.getSession(params.id)) return { _status: 404, error: 'unknown session' };
    const queued = scheduler.classifyNow(params.id);
    return { queued };
  };

  routes['POST /api/sessions/:id/label'] = (params, body) => {
    const allowed = ['client_work', 'internal_work', 'learning', 'personal', 'ignore', null];
    if (!allowed.includes(body.label)) return { _status: 400, error: 'invalid label' };
    grouping.setSessionLabel(params.id, body.label);
    return { ok: true };
  };

  routes['POST /api/sessions/:id/overrides'] = (params, body) => {
    if (typeof body.field_overrides !== 'object') return { _status: 400, error: 'field_overrides object required' };
    grouping.setSessionOverrides(params.id, body.field_overrides);
    return { ok: true };
  };

  routes['POST /api/sessions/:id/project'] = (params, body) => {
    grouping.setSessionProject(params.id, body.project_id || null);
    return { ok: true };
  };

  routes['GET /api/projects'] = () => grouping.getProjects();

  // Practitioner experience over this machine's own sessions. Local is
  // single-user, so the practitioner is implicitly "self" — no identity here;
  // machine→person mapping is a cloud concern.
  routes['GET /api/experience'] = () => {
    const corrections = grouping.loadCorrections();
    const exp = computeExperience(sessions.listSessions(), grouping.getProjects(), corrections, {
      practitionerOf: () => 'self',
      practitionerMeta: () => ({ id: 'self', display_name: 'This machine', provisional: false }),
    });
    return { ...exp, computed_at: new Date().toISOString() };
  };

  routes['POST /api/projects/:id/rename'] = (params, body) => {
    if (typeof body.name !== 'string' || !body.name.trim()) return { _status: 400, error: 'name required' };
    grouping.renameProject(params.id, body.name.trim());
    return { ok: true };
  };

  routes['POST /api/projects/:id/merge'] = (params, body) => {
    if (!body.into) return { _status: 400, error: 'into required' };
    grouping.mergeProjects(params.id, body.into);
    return { ok: true };
  };

  routes['POST /api/projects/:id/dismiss-merge'] = (params, body) => {
    if (!body.other) return { _status: 400, error: 'other required' };
    grouping.dismissMerge(params.id, body.other);
    return { ok: true };
  };

  routes['POST /api/recompute'] = () => {
    grouping.recompute();
    return { ok: true };
  };

  routes['GET /api/egress'] = () => egress.list(300);

  // The upload credential is WRITE-ONLY through this surface: reads mask it,
  // and saving the masked sentinel back preserves the stored value — so the
  // Settings JSON editor can round-trip without ever displaying the secret.
  const TOKEN_MASK = '__enrolled__';
  routes['GET /api/config'] = () => {
    const cfg = config.load();
    if (cfg.upload && cfg.upload.token) return { ...cfg, upload: { ...cfg.upload, token: TOKEN_MASK } };
    return cfg;
  };
  routes['POST /api/config'] = (params, body) => {
    if (body && body.upload && body.upload.token === TOKEN_MASK) {
      body = { ...body, upload: { ...body.upload, token: config.load().upload.token } };
    }
    const saved = config.save(body);
    return saved.upload && saved.upload.token ? { ...saved, upload: { ...saved.upload, token: TOKEN_MASK } } : saved;
  };

  return routes;
}

module.exports = { createApi };
