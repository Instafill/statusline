// @ts-check
'use strict';
// Adapter that runs the classification prompt through the local `claude` CLI
// in headless print mode. Auth rides on the user's existing Claude Code
// login. Guards against observing ourselves: STATUSLINE_SELF env (checked by
// hook-forward.js and the beep plugin) plus --safe-mode (hooks and all
// customizations disabled).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths } = require('../paths');
const { resolveCommand, detachOptions, killTree } = require('../util/platform');

// The bare command name, which is also the config default: `cli_path` staying
// at this value is what "the operator did not name a location" means.
const CLI_NAME = 'claude';

/** @type {string | null} */
let resolvedCli = null;

/**
 * Directories Claude Code installs into. A PATH lookup answers this for a
 * watcher started from a shell, but a launchd agent inherits
 * `/usr/bin:/bin:/usr/sbin:/sbin` and none of these sit on it.
 * @returns {string[]}
 */
function claudeInstallDirs() {
  return [
    path.join(os.homedir(), '.local', 'bin'), // the native installer's default
    path.dirname(process.execPath), // npm global lands in the bin of its own Node
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * @returns {string | null} absolute path to the CLI, or null
 */
function probeInstallDirs() {
  for (const dir of claudeInstallDirs()) {
    const candidate = path.join(dir, CLI_NAME);

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* absent, or present without the executable bit */
    }
  }

  return null;
}

/**
 * @param {string} cliPath the configured `classifier.cli_path`
 * @returns {string | null} where the CLI is, or null when nothing was found
 */
function resolveClassifierCli(cliPath) {
  if (cliPath !== CLI_NAME) return cliPath; // explicit path configured
  if (resolvedCli) return resolvedCli;
  resolvedCli = resolveCommand(CLI_NAME) || probeInstallDirs();
  return resolvedCli;
}

/**
 * The four properties of the `classifier` block in `src/config.js` that this
 * adapter reads. That block carries more.
 * @typedef {object} ClassifierConfig
 * @property {string} model
 * @property {string} [effort]
 * @property {string} cli_path
 * @property {number} timeout_ms
 */

/**
 * Runs one prompt.
 * @param {string} prompt
 * @param {ClassifierConfig} cfg
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function runClaude(prompt, cfg) {
  return new Promise((resolve) => {
    // When resolution finds nothing, spawn still gets the bare name and reports
    // ENOENT, which is the failure the caller needs to see.
    const cli = resolveClassifierCli(cfg.cli_path) || CLI_NAME;
    const args = [
      '-p',
      '--model',
      cfg.model,
      ...(cfg.effort ? ['--effort', cfg.effort] : []),
      '--output-format',
      'json',
      '--safe-mode', // no hooks, no CLAUDE.md, no MCP — auth still works
      '--no-session-persistence',
      '--tools',
      '', // disable ALL tools; this is a pure text classification call
    ];
    const child = spawn(cli, args, {
      cwd: paths.home, // never a real project directory
      // Checked on the first line of hook-forward.js and the beep plugin —
      // without it the watcher would observe its own classifier calls.
      env: { ...process.env, STATUSLINE_SELF: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...detachOptions(), // own process group on POSIX so killTree can reach the tree
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, cfg.timeout_ms);

    /**
     * @param {number | null} code
     * @param {Error} [err]
     */
    const settle = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: err ? `${stderr}\n${err.message}` : stderr, timedOut });
    };

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => settle(-1, err));
    child.on('close', (code) => settle(code));

    child.stdin.on('error', () => {}); // EPIPE if child died early
    child.stdin.end(prompt);
  });
}

/**
 * @param {unknown} text
 * @returns {object | null} first balanced JSON object in the text
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  // strip markdown fences if present
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = inStr;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

const AUTH_RE = /log ?in|logged out|oauth|401|credential|unauthorized|authentication|api key/i;

/**
 * One classification attempt.
 * @param {string} prompt
 * @param {ClassifierConfig} cfg
 * @returns {Promise<({outcome: 'ok', json: object} & CallFacts)
 *   | {outcome: 'timeout' | 'auth_error' | 'nonzero_exit' | 'parse_error', detail: string}>}
 */
async function attempt(prompt, cfg) {
  const res = await runClaude(prompt, cfg);
  if (res.timedOut) return { outcome: 'timeout', detail: `no result within ${cfg.timeout_ms}ms` };
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').slice(0, 2000);
    return {
      outcome: AUTH_RE.test(detail) ? 'auth_error' : 'nonzero_exit',
      detail: `exit ${res.code}: ${detail}`,
    };
  }
  // --output-format json envelope: { type:"result", subtype, result: "...", is_error, ... }
  let envelope;
  try {
    envelope = JSON.parse(res.stdout);
  } catch {
    /* not the JSON envelope — the raw stdout is used below instead */
  }
  const resultText = envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
  if (envelope && envelope.is_error) {
    const detail = String(envelope.result || '').slice(0, 2000);
    return { outcome: AUTH_RE.test(detail) ? 'auth_error' : 'nonzero_exit', detail };
  }
  const json = extractJsonObject(resultText);
  if (!json)
    return {
      outcome: 'parse_error',
      detail: `no JSON object in result: ${String(resultText).slice(0, 500)}`,
    };
  return { outcome: 'ok', json, ...callFacts(envelope) };
}

/**
 * What the call cost and which model served it. The configured name is only a
 * request. `modelUsage` is the answer, so the egress log can prove which model
 * ran rather than restating the setting.
 * @typedef {object} CallFacts
 * @property {string} [actual_model]
 * @property {number} [cost_usd]
 * @property {number} [input_tokens]
 * @property {number} [cache_read_tokens]
 * @property {number} [cache_creation_tokens]
 * @property {number} [output_tokens]
 */

/**
 * @param {any} envelope the `--output-format json` result, straight off the CLI
 * @returns {CallFacts}
 */
function callFacts(envelope) {
  if (!envelope) return {};
  const models =
    envelope.modelUsage && typeof envelope.modelUsage === 'object'
      ? Object.keys(envelope.modelUsage)
      : [];
  /** @type {CallFacts} */
  const facts = {};
  if (models.length) facts.actual_model = models.length === 1 ? models[0] : models.join(',');
  if (typeof envelope.total_cost_usd === 'number') facts.cost_usd = envelope.total_cost_usd;
  // Input tokens arrive split across fresh/cache-read/cache-write. Summing them
  // is what "tokens this call processed" means; keeping the parts lets the UI
  // explain a cheap call that still moved a lot of tokens.
  const u = envelope.usage || {};
  /** @param {unknown} x */
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  const inputParts =
    num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  if (inputParts) {
    facts.input_tokens = inputParts;
    if (num(u.cache_read_input_tokens)) facts.cache_read_tokens = u.cache_read_input_tokens;
    if (num(u.cache_creation_input_tokens))
      facts.cache_creation_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.output_tokens === 'number') facts.output_tokens = u.output_tokens;
  return facts;
}

module.exports = { attempt, extractJsonObject, resolveClassifierCli, kind: 'claude-cli' };
