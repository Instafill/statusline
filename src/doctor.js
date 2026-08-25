'use strict';
// Preflight checks. Every failure mode below otherwise shows up as silence
// hours later ("statusline sees nothing"), so each check names the exact fix.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { paths, claudeSettings } = require('./paths');
const { resolveCommand } = require('./util/platform');
const { resolveClassifierCli } = require('./classify/claude-cli');
const installer = require('./installer');
const { readAgentRoot, isPluginInstall, AGENT_ROOT } = require('./agent-root');
const autostart = require('./autostart');
const config = require('./config');

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

// The health endpoint is local and answers immediately, so a short ceiling
// turns a hung watcher into a fast warning instead of a stalled doctor run.
const HEALTH_TIMEOUT_MS = 2_000;

// How the health probe ended. DOWN is a socket error, which on a loopback
// address means nothing is listening. UNREACHABLE is a connection that opened
// and then timed out or returned something unparseable, which is a different
// machine state with a different repair.
const HEALTH_OK = 'ok';
const HEALTH_DOWN = 'down';
const HEALTH_UNREACHABLE = 'unreachable';

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    return {
      status: FAIL,
      detail: `Node ${process.versions.node} — statusline needs 22+`,
      fix: 'Install Node 22 or newer from https://nodejs.org',
    };
  }
  // The hook command is the bare word `node`; if that is not on PATH, hooks
  // silently fail inside every Claude Code session even though this CLI ran.
  if (!resolveCommand('node')) {
    return {
      status: FAIL,
      detail: `running on Node ${process.versions.node}, but "node" is not on PATH`,
      fix: 'Add node to your PATH — the installed hooks invoke it by bare name',
    };
  }
  return { status: OK, detail: `Node ${process.versions.node}` };
}

function checkClaudeCli() {
  const cfg = config.load();
  const resolved = resolveClassifierCli(cfg.classifier.cli_path);

  if (!resolved) {
    return {
      status: FAIL,
      detail: 'the `claude` CLI is not on PATH or in any known install directory',
      fix: 'Install Claude Code, or set classifier.cli_path in ~/.statusline/config.json',
    };
  }

  return { status: OK, detail: resolved };
}

// One real round-trip through the configured classifier path. This is the check
// that distinguishes "installed" from "logged in and working".
function checkClaudeAuth() {
  const cfg = config.load();
  const cli = resolveClassifierCli(cfg.classifier.cli_path);

  if (!cli) return { status: WARN, detail: 'skipped, CLI not found' };
  const res = spawnSync(
    cli,
    [
      '-p',
      '--model',
      cfg.classifier.model,
      '--safe-mode',
      '--no-session-persistence',
      '--tools',
      '',
    ],
    {
      input: 'Reply with the single word: ready',
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, STATUSLINE_SELF: '1' },
    }
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status === 0)
    return {
      status: OK,
      detail: `classifier round-trip succeeded (model: ${cfg.classifier.model})`,
    };
  if (/log ?in|logged out|oauth|401|credential|unauthorized|authentication|api key/i.test(out)) {
    return {
      status: FAIL,
      detail: 'the CLI is installed but not authenticated',
      fix: 'Run `claude` once and complete login',
    };
  }
  return {
    status: FAIL,
    detail: `classifier call failed: ${out.slice(0, 300)}`,
    fix: 'Run the same command by hand to see the full error',
  };
}

function checkSettings() {
  const st = installer.status();
  if (st.parseError)
    return {
      status: FAIL,
      detail: st.parseError,
      fix: `Fix the JSON in ${claudeSettings} by hand`,
    };
  // A plugin install registers its hooks through hooks/hooks.json, which Claude
  // Code loads directly — settings.json is untouched by design, so every check
  // below would report a problem that is not one.
  if (isPluginInstall()) {
    return st.fullyInstalled
      ? {
          status: WARN,
          detail:
            'installed as a plugin, but settings.json also carries hook entries from a checkout — every event is captured twice',
          fix: 'Run `node src/cli.js uninstall` from the checkout that registered them',
        }
      : {
          status: OK,
          detail: 'hooks come from the plugin manifest (settings.json is not modified)',
        };
  }
  if (!st.fullyInstalled) {
    const missing = st.entries.filter((e) => !e.installed).map((e) => e.event);
    return {
      status: FAIL,
      detail: `hooks missing: ${[...new Set(missing)].join(', ')}`,
      fix: 'Run `node src/cli.js install`',
    };
  }
  if (st.drift)
    return {
      status: WARN,
      detail: st.drift,
      fix: 'Run `node src/cli.js install` to refresh the hook entries',
    };
  return {
    status: OK,
    detail: `${st.entries.length} hook entries installed in ${st.settingsPath}`,
  };
}

// The logon task resolves the agent through the data dir rather than a path
// baked in at install time, so the failure to catch is a stale record: the
// recorded copy is gone (a plugin update collected it) and nothing starts.
function checkAgentRecord() {
  const rec = readAgentRoot();
  if (!rec) {
    return {
      status: WARN,
      detail: 'no agent location recorded yet',
      fix: 'Run `node src/cli.js autostart` so the watcher can start at login',
    };
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
    return {
      status: WARN,
      detail: 'the watcher will not start at login',
      fix: 'Run `node src/cli.js autostart` — otherwise events pile up unprocessed after every reboot',
    };
  }
  return { status: OK, detail: `${st.mechanism} "${st.id}" registered` };
}

/**
 * @typedef {object} CheckResult
 * @property {'ok' | 'warn' | 'fail'} status
 * @property {string} detail
 * @property {string} [fix] the exact command or edit that repairs it
 */

/**
 * @typedef {{ state: typeof HEALTH_OK, body: Record<string, any> }
 *   | { state: typeof HEALTH_DOWN }
 *   | { state: typeof HEALTH_UNREACHABLE, reason: string }} HealthProbe
 */

/**
 * Whether the watcher can reach the classifier from the environment it runs in.
 * The Claude CLI and Claude auth checks answer "installed" and "logged in" from
 * this shell, which on macOS is a different environment: a shell's PATH is built
 * by its rc files, a LaunchAgent gets launchd's, and launchd exposes no PATH to
 * read back. The watcher is the only process that knows, so it is asked.
 * @returns {Promise<CheckResult>}
 */
async function checkClassifierReach() {
  const cfg = config.load();
  const probe = await fetchHealth(cfg.port);

  if (probe.state !== HEALTH_OK) {
    return { status: WARN, detail: `skipped, ${probeFailure(probe)}` };
  }

  const health = probe.body;

  if (!('classifier_cli' in health)) {
    return {
      status: WARN,
      detail: 'the running watcher predates this check',
      fix: 'Restart the watcher: kill the pid in ~/.statusline/watcher.lock, then `node src/cli.js start`',
    };
  }

  if (!health.classifier_cli) {
    return {
      status: FAIL,
      detail: 'the watcher cannot find the `claude` CLI from its own environment',
      fix: 'Set classifier.cli_path to an absolute path in ~/.statusline/config.json, then restart the watcher',
    };
  }

  return { status: OK, detail: `the watcher resolved ${health.classifier_cli}` };
}

/**
 * Why a probe did not come back with a body, as a phrase to drop into a check's
 * detail line.
 * @param {HealthProbe} probe
 * @returns {string} empty for a probe that did answer
 */
function probeFailure(probe) {
  switch (probe.state) {
    case HEALTH_DOWN:
      return 'the watcher is not running';
    case HEALTH_UNREACHABLE:
      return `the watcher did not answer, ${probe.reason}`;
    default:
      return '';
  }
}

/**
 * @param {number} port
 * @returns {Promise<HealthProbe>}
 */
function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        let body = '';

        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve({ state: HEALTH_OK, body: JSON.parse(body) });
          } catch (e) {
            resolve({ state: HEALTH_UNREACHABLE, reason: `unreadable answer: ${e.message}` });
          }
        });
      }
    );

    req.on('error', () => resolve({ state: HEALTH_DOWN }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ state: HEALTH_UNREACHABLE, reason: `no answer within ${HEALTH_TIMEOUT_MS}ms` });
    });
  });
}

/**
 * Whether the watcher is up, by probing the local health endpoint. When it is
 * not, the detail carries how many events are waiting in the spool, since that
 * number is what the downtime has cost so far.
 * @returns {Promise<CheckResult>}
 */
async function checkWatcher() {
  const cfg = config.load();
  const probe = await fetchHealth(cfg.port);

  if (probe.state === HEALTH_OK) {
    return { status: OK, detail: `running at http://127.0.0.1:${cfg.port}` };
  }

  let pending = 0;

  try {
    pending = fs.readdirSync(paths.spoolNew).length;
  } catch (e) {
    /* spool may not exist yet */
  }

  const waiting = pending ? `, ${pending} event(s) waiting in the spool` : '';

  return {
    status: WARN,
    detail: `${probeFailure(probe)}${waiting}`,
    fix: 'Run `node src/cli.js start` (or `node src/cli.js autostart`)',
  };
}

// One empty ingest batch (a pure heartbeat) proves endpoint reachability AND
// credential acceptance in a single call. It is an attempt on the upload
// channel, so it is egress-logged like any other (CLAUDE.md rule 2).
async function checkUpload() {
  const cfg = config.load();
  if (!cfg.upload.enabled) return { status: OK, detail: 'disabled (local-only mode)' };
  if (!cfg.upload.endpoint || !cfg.upload.token) {
    return {
      status: FAIL,
      detail: 'upload enabled but endpoint/token missing',
      fix: 'Enroll this machine: node src/cli.js join <url> <code> (mint the code from your team dashboard)',
    };
  }
  const egress = require('./classify/egress');
  const { machineIdentity } = require('./upload/identity');
  const { ingestUrl, endpointHost } = require('./upload/endpoints');
  const machine = machineIdentity();
  const host = endpointHost(cfg.upload.endpoint);
  const entry = {
    kind: 'upload',
    endpoint_host: host,
    session_count: 0,
    session_ids: [],
    probe: 'doctor',
  };
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
    if (res.ok)
      return {
        status: OK,
        detail: `${host} reachable, credential accepted (machine ${machine.machine_id})`,
      };
    if (res.status === 401) {
      return {
        status: FAIL,
        detail:
          "the team endpoint rejected this machine's credential (revoked, or the shared token was retired)",
        fix: 'Re-enroll: node src/cli.js join <url> <code>',
      };
    }
    return {
      status: FAIL,
      detail: `team endpoint answered ${res.status}`,
      fix: "Check the endpoint /healthz and this machine's clock",
    };
  } catch (e) {
    entry.duration_ms = Date.now() - t0;
    entry.outcome = e.name === 'AbortError' ? 'timeout' : 'network_error';
    entry.error = String(e.message || e).slice(0, 200);
    egress.record(entry);
    return {
      status: FAIL,
      detail: `team endpoint unreachable: ${entry.error}`,
      fix: 'Check the URL in ~/.statusline/config.json upload.endpoint and your network',
    };
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
  // After Watcher: it reads what that check proved is up, and a stopped watcher
  // should be reported once, by the check that owns it.
  ['Classifier reach', checkClassifierReach],
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
