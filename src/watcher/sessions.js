'use strict';
// Event normalization, pruning, and the fold that turns a session's
// append-only event log into derived session state. State is ALWAYS re-derived
// from the log (never incrementally mutated) so restarts, duplicate spool
// deliveries, and interleaved concurrent sessions are handled by construction.
const fs = require('fs');
const path = require('path');
const { paths, sessionFile, sessionEventsFile } = require('../paths');
const { readJson, writeJsonAtomic, appendJsonl, readJsonl } = require('../util/jsonfile');
const { maskSecrets } = require('../util/secrets');
const { gitInfo } = require('../util/gitroot');
const config = require('../config');

const EXCERPT_LEN = 500;
const PRUNE_THRESHOLD = 4000;
const ALWAYS_EXCERPT_KEYS = new Set(['content', 'new_string', 'old_string']);

function excerptOf(s, keepChars) {
  return { _excerpt: s.slice(0, keepChars), _omitted_chars: s.length - keepChars };
}

function pruneToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput;
  const out = Array.isArray(toolInput) ? [] : {};
  for (const [k, v] of Object.entries(toolInput)) {
    if (
      typeof v === 'string' &&
      (ALWAYS_EXCERPT_KEYS.has(k) ? v.length > EXCERPT_LEN : v.length > PRUNE_THRESHOLD)
    ) {
      out[k] = excerptOf(v, EXCERPT_LEN);
    } else if (v && typeof v === 'object') {
      out[k] = pruneToolInput(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function normalizeEvent(payload, fileId, receivedAtIso) {
  const pruned = { ...payload };
  if (typeof pruned.prompt === 'string' && pruned.prompt.length > PRUNE_THRESHOLD) {
    pruned.prompt = excerptOf(pruned.prompt, PRUNE_THRESHOLD);
  }
  if (pruned.tool_input) pruned.tool_input = pruneToolInput(pruned.tool_input);
  // tool_response is not expected in payloads, but drop it defensively if a
  // future Claude Code version adds it — we never store tool outputs.
  delete pruned.tool_response;
  return {
    id: fileId,
    at: receivedAtIso,
    event: payload.hook_event_name,
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || null,
    payload: pruned,
  };
}

// Parses a raw spool buffer, validates it, appends to the session's event log.
// Throws on anything unusable (caller quarantines the spool file).
function ingestBuffer(buf, fileId, receivedAtIso) {
  const payload = JSON.parse(buf.toString('utf8'));
  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object');
  if (typeof payload.session_id !== 'string' || !payload.session_id)
    throw new Error('missing session_id');
  if (typeof payload.hook_event_name !== 'string' || !payload.hook_event_name)
    throw new Error('missing hook_event_name');
  const event = normalizeEvent(payload, fileId, receivedAtIso);
  appendJsonl(sessionEventsFile(payload.session_id), event);
  return payload.session_id;
}

function textOf(field) {
  if (typeof field === 'string') return { text: field, omitted: 0 };
  if (field && typeof field === 'object' && typeof field._excerpt === 'string') {
    return { text: field._excerpt, omitted: field._omitted_chars || 0 };
  }
  return null;
}

// Only EDITS corroborate hands-on technology evidence (eval finding F8: a
// mere Read of a .ts file must never verify TypeScript experience). Reads are
// still listed in files_touched and counted separately for digest context.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILE_TOOLS = new Set([...EDIT_TOOLS, 'Read']);

// UserPromptSubmit also fires for machine-generated turns (background-task
// notifications, slash-command echoes, system reminders). Those are not user
// prompts and must not count toward prompts/turns.
const SYSTEM_PROMPT_RE = /^\s*<(?:task-notification|command-name|local-command|system-reminder)/;

const DEP_PATTERNS = [
  /\b(?:npm|pnpm)\s+(?:i|install|add)\s+((?:[^\s;|&"']+\s*)+)/g,
  /\byarn\s+add\s+((?:[^\s;|&"']+\s*)+)/g,
  /\bpip3?\s+install\s+((?:[^\s;|&"']+\s*)+)/g,
  /\buv\s+(?:pip\s+install|add)\s+((?:[^\s;|&"']+\s*)+)/g,
  /\bcargo\s+add\s+((?:[^\s;|&"']+\s*)+)/g,
  /\bgo\s+get\s+((?:[^\s;|&"']+\s*)+)/g,
  /\bcomposer\s+require\s+((?:[^\s;|&"']+\s*)+)/g,
  /\bgem\s+install\s+((?:[^\s;|&"']+\s*)+)/g,
];

function extractDependencies(command) {
  const deps = [];
  for (const re of DEP_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(command)) !== null) {
      for (const tok of m[1].split(/\s+/)) {
        if (!tok || tok.startsWith('-')) continue;
        deps.push(tok.replace(/@[\^~]?[\d.].*$/, '')); // strip version suffixes
      }
    }
  }
  return deps;
}

function counterAdd(map, key, n = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + n;
}

function mostFrequent(counter) {
  let best = null;
  let bestN = -1;
  for (const [k, n] of Object.entries(counter)) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function deriveState(sid, events) {
  // Dedupe by event id, order by received time (spool filename timestamp).
  const seen = new Set();
  const ordered = [];
  for (const e of events) {
    if (!e || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    ordered.push(e);
  }
  ordered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const state = {
    v: 1,
    session_id: sid,
    created_at: null,
    updated_at: new Date().toISOString(),
    last_event_at: null,
    sources: [],
    end_reason: null,
    end_at: null,
    cwds: [],
    primary_cwd: null,
    git_root: null,
    // Name of the linked git worktree the work happened in, or null for the
    // main worktree / no repo. Only ever rendered when set.
    git_worktree: null,
    // Main worktree's repo root when this session ran in a *linked* worktree
    // (grouping folds it into the parent repo's project); null otherwise.
    git_main_root: null,
    // Credential-stripped `remote.origin.url` — identifies the same repo across
    // machines and checkout paths. Null when no remote or no repo.
    git_origin: null,
    // PID of the Claude Code process that owns this session (from CLAUDE_PID,
    // captured by the hook). Lets the UI show whether the session is still
    // open in a terminal. Null for sessions observed before this was captured.
    host_pid: null,
    transcript_path: null,
    permission_modes: [],
    counts: { prompts: 0, turns: 0, tool_uses: 0, subagent_events: 0, events: ordered.length },
    prompts: [],
    tools: {
      by_name: {},
      bash_commands: [],
      files_touched: [],
      extensions: {}, // edited files only — this is hands-on evidence
      extensions_read: {}, // read-only access — context, never evidence
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
  };

  const cwdCounter = {};
  const bashSet = new Set();
  const fileSet = new Set();
  const mcpSet = new Set();
  const domainSet = new Set();
  const querySet = new Set();
  const depSet = new Set();
  const sourceSet = new Set();
  const permSet = new Set();
  let promptSinceStop = false;

  for (const e of ordered) {
    const p = e.payload || {};
    if (!state.created_at) state.created_at = e.at;
    state.last_event_at = e.at;
    if (typeof p.cwd === 'string' && p.cwd) counterAdd(cwdCounter, p.cwd);
    if (typeof p.transcript_path === 'string' && p.transcript_path)
      state.transcript_path = p.transcript_path;
    if (p._statusline && Number.isInteger(p._statusline.claude_pid))
      state.host_pid = p._statusline.claude_pid;
    if (typeof p.permission_mode === 'string' && p.permission_mode) permSet.add(p.permission_mode);
    if (e.agent_id) state.counts.subagent_events++;

    switch (e.event) {
      case 'SessionStart':
        if (typeof p.source === 'string') sourceSet.add(p.source);
        break;
      case 'SessionEnd':
        state.end_reason = typeof p.reason === 'string' ? p.reason : 'unknown';
        state.end_at = e.at;
        break;
      case 'UserPromptSubmit': {
        if (e.agent_id) break; // subagent prompts are machine-generated
        const t = textOf(p.prompt);
        if (t && !SYSTEM_PROMPT_RE.test(t.text)) {
          state.counts.prompts++;
          state.prompts.push({ at: e.at, text: maskSecrets(t.text), omitted_chars: t.omitted });
          promptSinceStop = true;
        }
        break;
      }
      case 'Stop':
        if (!e.agent_id && promptSinceStop) {
          state.counts.turns++;
          promptSinceStop = false;
        }
        break;
      case 'PostToolUse': {
        const name = typeof p.tool_name === 'string' ? p.tool_name : 'unknown';
        state.counts.tool_uses++;
        counterAdd(state.tools.by_name, name);
        const input = p.tool_input || {};
        if (name === 'Bash' || name === 'PowerShell') {
          const t = textOf(input.command);
          if (t) bashSet.add(maskSecrets(t.text));
        } else if (FILE_TOOLS.has(name)) {
          const fp = typeof input.file_path === 'string' ? input.file_path : null;
          if (fp) {
            fileSet.add(fp);
            const ext = path.extname(fp).toLowerCase();
            if (ext)
              counterAdd(
                EDIT_TOOLS.has(name) ? state.tools.extensions : state.tools.extensions_read,
                ext
              );
          }
        } else if (name.startsWith('mcp__')) {
          const server = name.split('__')[1];
          if (server) mcpSet.add(server);
        } else if (name === 'WebFetch') {
          try {
            domainSet.add(new URL(input.url).hostname);
          } catch (err) {
            /* unparseable url — skip */
          }
        } else if (name === 'WebSearch') {
          const t = textOf(input.query);
          if (t) querySet.add(t.text.slice(0, 200));
        }
        if (name === 'Bash' || name === 'PowerShell') {
          const t = textOf(input.command);
          if (t) for (const d of extractDependencies(t.text)) depSet.add(d);
        }
        break;
      }
      default:
        break;
    }
  }

  state.sources = [...sourceSet];
  state.permission_modes = [...permSet];
  state.cwds = Object.keys(cwdCounter);
  state.primary_cwd = mostFrequent(cwdCounter);
  const git = gitInfo(state.primary_cwd);
  state.git_root = git.root;
  state.git_worktree = git.worktree;
  state.git_main_root = git.main_root;
  state.git_origin = git.origin;
  state.tools.bash_commands = [...bashSet].slice(0, 200);
  state.tools.files_touched = [...fileSet].slice(0, 500);
  state.tools.mcp_servers = [...mcpSet];
  state.tools.web.fetch_domains = [...domainSet].slice(0, 50);
  state.tools.web.search_queries = [...querySet].slice(0, 50);
  state.tools.dependencies_observed = [...depSet].slice(0, 100);
  return state;
}

// Fields owned by the classification pipeline — preserved across re-folds.
const CLASSIFY_FIELDS = [
  'assistant_excerpts',
  'digest',
  'classification_state',
  'classification',
  'classified_at',
  'turns_at_classification',
  'classifier_error',
];

function foldSession(sid) {
  const events = readJsonl(sessionEventsFile(sid));
  if (events.length === 0) return null;
  const derived = deriveState(sid, events);
  const existing = readJson(sessionFile(sid), {});
  const state = { ...existing, ...derived };
  for (const f of CLASSIFY_FIELDS) {
    if (existing[f] !== undefined) state[f] = existing[f];
  }
  if (state.classification_state === undefined) state.classification_state = 'unclassified';
  if (state.turns_at_classification === undefined) state.turns_at_classification = 0;

  // classification.technologies and .business_capabilities are DERIVED:
  // recomputed every fold from the LLM's raw claims + current tool state +
  // the normalization tables / capability catalog, so table and catalog
  // updates (team config) correct history without a classifier call.
  if (state.classification) {
    const evidence = require('../evidence');
    evidence.deriveTechnologies(state);
    evidence.deriveBusinessCapabilities(state);
  }

  // Staleness: significant new activity after a completed classification.
  if (state.classification_state === 'classified') {
    const cfg = config.load();
    const newTurns = state.counts.turns - (state.turns_at_classification || 0);
    const endedAfter = state.end_at && state.classified_at && state.end_at > state.classified_at;
    if (newTurns >= cfg.reclassify_min_new_turns || endedAfter)
      state.classification_state = 'stale';
  }

  writeJsonAtomic(sessionFile(sid), state);
  return state;
}

function getSession(sid) {
  return readJson(sessionFile(sid), null);
}

function updateSession(sid, patch) {
  const state = readJson(sessionFile(sid), null);
  if (!state) return null;
  const next = { ...state, ...patch, updated_at: new Date().toISOString() };
  writeJsonAtomic(sessionFile(sid), next);
  return next;
}

function listSessions() {
  let files;
  try {
    files = fs.readdirSync(paths.sessionsDir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.events.jsonl')) continue;
    const state = readJson(path.join(paths.sessionsDir, f), null);
    if (state && state.session_id) out.push(state);
  }
  out.sort((a, b) => (a.last_event_at < b.last_event_at ? 1 : -1));
  return out;
}

function getEvents(sid, limit = 500) {
  const events = readJsonl(sessionEventsFile(sid));
  return events.slice(-limit);
}

module.exports = {
  ingestBuffer,
  foldSession,
  getSession,
  updateSession,
  listSessions,
  getEvents,
  normalizeEvent,
  deriveState,
};
