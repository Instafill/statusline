'use strict';
// Preflight checks. Every failure mode below otherwise shows up as silence
// hours later ("statusline sees nothing"), so each check names the exact fix.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { paths, claudeSettings } = require('./paths');
const { resolveCommand } = require('./util/platform');
const installer = require('./installer');
const { readAgentRoot, isPluginInstall, AGENT_ROOT } = require('./agent-root');
const autostart = require('./autostart');
const config = require('./config');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    return { status: FAIL, detail: `Node ${process.versions.node} — statusline needs 18+`, fix: 'Install Node 18 or newer from https://nodejs.org' };
  }
  // The hook command is the bare word `node`; if that is not on PATH, hooks
  // silently fail inside every Claude Code session even though this CLI ran.
  if (!resolveCommand('node')) {
    return { status: FAIL, detail: `running on Node ${process.versions.node}, but "node" is not on PATH`, fix: 'Add node to your PATH — the installed hooks invoke it by bare name' };
  }
  return { status: OK, detail: `Node ${process.versions.node}` };
}

function checkClaudeCli() {
  const cfg = config.load();
  const configured = cfg.classifier.cli_path;
  const resolved = configured === 'claude' ? resolveCommand('claude') : configured;
  if (!resolved) {
    return { status: FAIL, detail: 'the `claude` CLI is not on PATH', fix: 'Install Claude Code, or set classifier.cli_path in ~/.statusline/config.json' };
  }
  return { status: OK, detail: resolved };
}

// One real round-trip through the configured classifier path. This is the check
// that distinguishes "installed" from "logged in and working".
function checkClaudeAuth() {
  const cfg = config.load();
  const cli = cfg.classifier.cli_path === 'claude' ? resolveCommand('claude') : cfg.classifier.cli_path;
  if (!cli) return { status: WARN, detail: 'skipped — CLI not found' };
  const res = spawnSync(
    cli,
    ['-p', '--model', cfg.classifier.model, '--safe-mode', '--no-session-persistence', '--tools', ''],
    { input: 'Reply with the single word: ready', encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, STATUSLINE_SELF: '1' } }
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0) return { status: OK, detail: `classifier round-trip succeeded (model: ${cfg.classifier.model})` };
  if (/log ?in|logged out|oauth|401|credential|unauthorized|authentication|api key/i.test(out)) {
    return { status: FAIL, detail: 'the CLI is installed but not authenticated', fix: 'Run `claude` once and complete login' };
  }
  return { status: FAIL, detail: `classifier call failed: ${out.slice(0, 300)}`, fix: 'Run the same command by hand to see the full error' };
}

function checkSettings() {
  const st = installer.status();
  if (st.parseError) return { status: FAIL, detail: st.parseError, fix: `Fix the JSON in ${claudeSettings} by hand` };
  // A plugin install registers its hooks through hooks/hooks.json, which Claude
  // Code loads directly — settings.json is untouched by design, so every check
  // below would report a problem that is not one.
  if (isPluginInstall()) {
    return st.fullyInstalled
      ? {
          status: WARN,
          detail: 'installed as a plugin, but settings.json also carries hook entries from a checkout — every event is captured twice',
          fix: 'Run `node src/cli.js uninstall` from the checkout that registered them',
        }
      : { status: OK, detail: 'hooks come from the plugin manifest (settings.json is not modified)' };
  }
  if (!st.fullyInstalled) {
    const missing = st.entries.filter((e) => !e.installed).map((e) => e.event);
    return { status: FAIL, detail: `hooks missing: ${[...new Set(missing)].join(', ')}`, fix: 'Run `node src/cli.js install`' };
  }
  if (st.drift) return { status: WARN, detail: st.drift, fix: 'Run `node src/cli.js install` to refresh the hook entries' };
  return { status: OK, detail: `${st.entries.length} hook entries installed in ${st.settingsPath}` };
}

// The logon task resolves the agent through the data dir rather than a path
// baked in at install time, so the failure to catch is a stale record: the
// recorded copy is gone (a plugin update collected it) and nothing starts.
function checkAgentRecord() {
  const rec = readAgentRoot();
  if (!rec) {
    return { status: WARN, detail: 'no agent location recorded yet', fix: 'Run `node src/cli.js autostart` so the watcher can start at login' };
  }
  if (!fs.existsSync(path.join(rec.root, 'src', 'cli.js'))) {
    return {
      status: FAIL,
      detail: `the recorded agent is gone (${rec.root})`,
      fix: 'Run `node src/cli.js autostart` from the copy you use now',
    };
  }
  if (rec.root !== AGENT_ROOT) {
    return {
      status: WARN,
      detail: `login starts a different copy (${rec.root}) than this one`,
      fix: 'Run `node src/cli.js autostart` here if this is the copy you want at login',
    };
  }
  return { status: OK, detail: `agent at ${rec.root}${isPluginInstall() ? ' (plugin)' : ''}` };
}

function checkAutostart() {
  let st;
  try {
    st = autostart.status();
  } catch (e) {
    return { status: WARN, detail: `could not determine autostart state: ${e.message}` };
  }
  if (!st.enabled) {
    return { status: WARN, detail: 'the watcher will not start at login', fix: 'Run `node src/cli.js autostart` — otherwise events pile up unprocessed after every reboot' };
  }
  return { status: OK, detail: `${st.mechanism} "${st.id}" registered` };
}

function checkWatcher() {
  const cfg = config.load();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: cfg.port, path: '/api/health', timeout: 2000 }, (res) => {
      res.resume();
      resolve({ status: OK, detail: `running at http://127.0.0.1:${cfg.port}` });
    });
    req.on('error', () => {
      let pending = 0;
      try {
        pending = fs.readdirSync(paths.spoolNew).length;
      } catch (e) { /* spool may not exist yet */ }
      resolve({
        status: WARN,
        detail: `not running${pending ? ` — ${pending} event(s) waiting in the spool` : ''}`,
        fix: 'Run `node src/cli.js start` (or `node src/cli.js autostart`)',
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: WARN, detail: 'health check timed out' });
    });
  });
}

// One empty ingest batch (a pure heartbeat) proves endpoint reachability AND
// credential acceptance in a single call. It is an attempt on the upload
// channel, so it is egress-logged like any other (CLAUDE.md rule 2).
async function checkUpload() {
  const cfg = config.load();
  if (!cfg.upload.enabled) return { status: OK, detail: 'disabled (local-only mode)' };
  if (!cfg.upload.endpoint || !cfg.upload.token) {
    return { status: FAIL, detail: 'upload enabled but endpoint/token missing', fix: 'Enroll this machine: node src/cli.js join <url> <code> (mint the code from your team dashboard)' };
  }
  const egress = require('./classify/egress');
  const { machineIdentity } = require('./upload/identity');
  const { ingestUrl, endpointHost } = require('./upload/endpoints');
  const machine = machineIdentity();
  const host = endpointHost(cfg.upload.endpoint);
  const entry = { kind: 'upload', endpoint_host: host, session_count: 0, session_ids: [], probe: 'doctor' };
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(ingestUrl(cfg.upload.endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.upload.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, machine, sessions: [] }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    entry.http_status = res.status;
    entry.duration_ms = Date.now() - t0;
    entry.outcome = res.ok ? 'ok' : `http_${res.status}`;
    egress.record(entry);
    if (res.ok) return { status: OK, detail: `${host} reachable, credential accepted (machine ${machine.machine_id})` };
    if (res.status === 401) {
      return { status: FAIL, detail: 'the team endpoint rejected this machine\'s credential (revoked, or the shared token was retired)', fix: 'Re-enroll: node src/cli.js join <url> <code>' };
    }
    return { status: FAIL, detail: `team endpoint answered ${res.status}`, fix: 'Check the endpoint /healthz and this machine\'s clock' };
  } catch (e) {
    entry.duration_ms = Date.now() - t0;
    entry.outcome = e.name === 'AbortError' ? 'timeout' : 'network_error';
    entry.error = String(e.message || e).slice(0, 200);
    egress.record(entry);
    return { status: FAIL, detail: `team endpoint unreachable: ${entry.error}`, fix: 'Check the URL in ~/.statusline/config.json upload.endpoint and your network' };
  }
}

const CHECKS = [
  ['Node runtime', checkNode],
  ['Claude CLI', checkClaudeCli],
  ['Claude auth', checkClaudeAuth],
  ['Hooks', checkSettings],
  ['Autostart', checkAutostart],
  ['Agent location', checkAgentRecord],
  ['Watcher', checkWatcher],
  ['Upload', checkUpload],
];

async function run({ skipAuth = false } = {}) {
  const results = [];
  for (const [name, fn] of CHECKS) {
    if (skipAuth && name === 'Claude auth') {
      results.push({ name, status: WARN, detail: 'skipped (--no-auth)' });
      continue;
    }
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { status: FAIL, detail: e.message };
    }
    results.push({ name, ...r });
  }
  return results;
}

module.exports = { run, OK, WARN, FAIL };
