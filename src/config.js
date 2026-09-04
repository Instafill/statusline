'use strict';
const { paths, ensureDirs } = require('./paths');
const { readJson, fileExists, writeJsonAtomic } = require('./util/jsonfile');

const DEFAULTS = {
  v: 1,
  port: 45817,
  bind: '127.0.0.1',
  idle_minutes: 10,
  reclassify_min_new_turns: 5,
  digest: {
    max_chars: 10000,
    max_prompt_chars: 1500,
    max_prompts: 20,
    max_bash_commands: 40,
    max_files: 60,
    max_excerpts: 5,
    max_excerpt_chars: 800,
  },
  classifier: {
    kind: 'claude-cli',
    // opus won the 2026-08 quality bake-off (9 sessions × 7 variants: zero
    // factual errors, best task fidelity); low effort keeps output terse.
    model: 'opus',
    effort: 'low',
    cli_path: 'claude',
    timeout_ms: 120000,
    max_retries: 1,
    // Continuation sessions (resume/compact/fork) inherit the project's most
    // recent LLM classification instead of spending a classifier call, unless
    // their tool evidence diverges from the donor's technologies.
    inherit: {
      enabled: true,
      max_age_hours: 72,
      min_token_overlap: 0.5,
    },
    // When the classifier is unreachable (logged out, offline, timing out),
    // store a low-confidence deterministic classification instead of failing;
    // the scheduler upgrades it once the classifier works again.
    heuristic_fallback: true,
  },
  spool: {
    rescan_ms: 5000,
    quarantine_keep_days: 14,
  },
  // Attention beep. Owned by the statusline-beep plugin
  // (github.com/ogamaniuk/statusline-beep, its own repo since 2026-08-18) —
  // the schema stays here because this file is where it is configured and
  // where the Settings panel reads it. The plugin reads this block fresh on
  // every Stop / Notification, so a toggle takes effect immediately with no
  // restart. Off by default: nobody should start making noise without asking
  // for it.
  beep: {
    enabled: false,
    on_stop: true,
    on_notification: true,
    // Regex tested against the Notification message ("permission" narrows it to
    // permission prompts, dropping the 60s idle nudge). null = every one.
    notification_filter: null,
    min_interval_ms: 1500,
    // ["22:00", "08:00"] — local time, wraps midnight. null = always audible.
    quiet_hours: null,
    // Pitch identifies the project (hashed git root → a pentatonic note), so a
    // wall of tabs is distinguishable by ear; the pattern still says whether
    // it finished or is blocked.
    project_pitch: true,
    // Custom player: [exe, ...args] runs directly, a string runs through the
    // shell. STATUSLINE_BEEP_EVENT names the trigger in its environment.
    command: null,
  },
  retention: {
    events_keep_days: 90,
    egress_keep_days: 90,
  },
  // Team upload: when enabled, session docs and watcher heartbeats are POSTed
  // to the configured team endpoint. This is the second sanctioned egress
  // channel (CLAUDE.md rule 2) — every attempt lands in egress.jsonl. Off by
  // default; the watcher loads no upload code while disabled.
  upload: {
    enabled: false,
    endpoint: '',
    token: '',
    debounce_ms: 10000,
    // NOTE 2026-08-17: uploads are ALWAYS content-stripped (classification +
    // metadata only — src/upload/strip.js). The old include_content option is
    // gone; a leftover key in config.json is ignored.
  },
  log_level: 'info',
};

function merge(base, overlay) {
  if (overlay === null || overlay === undefined) return base;
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay;
  if (typeof base === 'object' && typeof overlay === 'object') {
    const out = { ...base };
    for (const k of Object.keys(overlay)) out[k] = merge(base[k], overlay[k]);
    return out;
  }
  return overlay;
}

let cached = null;

// An existing-but-unreadable config is NEVER overwritten: it holds the
// upload credential and every local preference, and silently replacing it
// with DEFAULTS turns one bad edit into permanent data loss (it did once —
// a stray BOM). Seed the file only when it genuinely does not exist; on a
// parse failure run on defaults in memory and say so loudly.
function load(force) {
  if (cached && !force) return cached;
  ensureDirs();
  const overlay = readJson(paths.config, null);
  if (!overlay) {
    if (fileExists(paths.config)) {
      console.error(
        `statusline: ${paths.config} is not valid JSON — running on defaults, file left untouched. Fix it and restart.`
      );
    } else {
      writeJsonAtomic(paths.config, DEFAULTS);
    }
  }
  cached = merge(DEFAULTS, overlay || {});
  return cached;
}

function save(next) {
  const current = load();
  const updated = merge(current, next);
  writeJsonAtomic(paths.config, updated);
  cached = updated;
  return updated;
}

module.exports = { DEFAULTS, load, save };
