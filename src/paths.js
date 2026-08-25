'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// STATUSLINE_HOME override exists for tests; hooks/hook-forward.js honors the
// same variable independently (it must not import from src/).
const HOME = process.env.STATUSLINE_HOME || path.join(os.homedir(), '.statusline');

const paths = {
  home: HOME,
  config: path.join(HOME, 'config.json'),
  manifest: path.join(HOME, 'install-manifest.json'),
  lock: path.join(HOME, 'watcher.lock'),
  spoolTmp: path.join(HOME, 'spool', 'tmp'),
  spoolNew: path.join(HOME, 'spool', 'new'),
  spoolQuarantine: path.join(HOME, 'spool', 'quarantine'),
  sessionsDir: path.join(HOME, 'sessions'),
  backupsDir: path.join(HOME, 'backups'),
  tmpDir: path.join(HOME, 'tmp'),
  projects: path.join(HOME, 'projects.json'),
  corrections: path.join(HOME, 'corrections.json'),
  egress: path.join(HOME, 'egress.jsonl'),
  // Stable machine identity for team uploads (random UUID, generated once).
  machine: path.join(HOME, 'machine.json'),
  // Per-session sha of the last successfully uploaded doc (never inside
  // session state — fold invariants stay untouched).
  uploadState: path.join(HOME, 'upload-state.json'),
  // Server-distributed normalization tables (validated overlay from the ingest
  // ACK) + the marker of which version this machine last applied to its
  // sessions. Absent on disabled installs — repo defaults apply.
  teamConfig: path.join(HOME, 'team-config.json'),
  teamConfigApplied: path.join(HOME, 'team-config-applied.json'),
  // Tiny pre-computed rollup for the Claude Code status line, so rendering it
  // is one small read instead of a scan of every session file.
  summary: path.join(HOME, 'summary.json'),
  logFile: path.join(HOME, 'watcher.log'),
  // Where the agent itself currently lives, plus the stable launcher autostart
  // points at (see src/agent-root.js) — a plugin update moves the code, this
  // pair does not move.
  agent: path.join(HOME, 'agent.json'),
  launcher: path.join(HOME, 'start-watcher.js'),
};

const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');

// hook-forward.js lives in <repo>/hooks/; installer embeds this absolute path
// into the hook command string.
const hookScript = path.resolve(__dirname, '..', 'hooks', 'hook-forward.js');

function ensureDirs() {
  for (const dir of [
    paths.home,
    paths.spoolTmp,
    paths.spoolNew,
    paths.spoolQuarantine,
    paths.sessionsDir,
    paths.backupsDir,
    paths.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// session_id comes from external input (hook payloads); sanitize before using
// as a filename so a hostile payload cannot traverse paths.
function safeSessionId(sid) {
  return String(sid)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 128);
}

function sessionFile(sid) {
  return path.join(paths.sessionsDir, safeSessionId(sid) + '.json');
}

function sessionEventsFile(sid) {
  return path.join(paths.sessionsDir, safeSessionId(sid) + '.events.jsonl');
}

module.exports = {
  paths,
  claudeSettings,
  hookScript,
  ensureDirs,
  safeSessionId,
  sessionFile,
  sessionEventsFile,
};
