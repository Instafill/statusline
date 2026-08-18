'use strict';
// Adapter that runs the classification prompt through the local `claude` CLI
// in headless print mode. Auth rides on the user's existing Claude Code
// login. Guards against observing ourselves: STATUSLINE_SELF env (checked by
// hook-forward.js and the beep plugin) plus --safe-mode (hooks and all
// customizations disabled).
const { spawn } = require('child_process');
const { paths } = require('../paths');
const log = require('../util/log');
const { resolveCommand, detachOptions, killTree } = require('../util/platform');

let resolvedCli = null;

function resolveCli(cliPath) {
  if (cliPath !== 'claude') return cliPath; // explicit path configured
  if (resolvedCli) return resolvedCli;
  resolvedCli = resolveCommand('claude') || 'claude';
  return resolvedCli;
}

// Runs one prompt, returns { code, stdout, stderr, timedOut }.
function runClaude(prompt, cfg) {
  return new Promise((resolve) => {
    const cli = resolveCli(cfg.cli_path);
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

// One classification attempt. Returns:
// { outcome: 'ok', json }  or  { outcome: 'timeout'|'auth_error'|'nonzero_exit'|'parse_error', detail }
async function attempt(prompt, cfg) {
  const res = await runClaude(prompt, cfg);
  if (res.timedOut) return { outcome: 'timeout', detail: `no result within ${cfg.timeout_ms}ms` };
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').slice(0, 2000);
    return { outcome: AUTH_RE.test(detail) ? 'auth_error' : 'nonzero_exit', detail: `exit ${res.code}: ${detail}` };
  }
  // --output-format json envelope: { type:"result", subtype, result: "...", is_error, ... }
  let envelope = null;
  try {
    envelope = JSON.parse(res.stdout);
  } catch (e) {
    envelope = null;
  }
  const resultText = envelope && typeof envelope.result === 'string' ? envelope.result : res.stdout;
  if (envelope && envelope.is_error) {
    const detail = String(envelope.result || '').slice(0, 2000);
    return { outcome: AUTH_RE.test(detail) ? 'auth_error' : 'nonzero_exit', detail };
  }
  const json = extractJsonObject(resultText);
  if (!json) return { outcome: 'parse_error', detail: `no JSON object in result: ${String(resultText).slice(0, 500)}` };
  return { outcome: 'ok', json, ...callFacts(envelope) };
}

// What the call actually cost and which model actually served it. The configured
// name ("haiku") is only a request; modelUsage is the answer, so the egress log
// can prove which model ran rather than restating the setting.
function callFacts(envelope) {
  if (!envelope) return {};
  const models = envelope.modelUsage && typeof envelope.modelUsage === 'object' ? Object.keys(envelope.modelUsage) : [];
  const facts = {};
  if (models.length) facts.actual_model = models.length === 1 ? models[0] : models.join(',');
  if (typeof envelope.total_cost_usd === 'number') facts.cost_usd = envelope.total_cost_usd;
  // Input tokens arrive split across fresh/cache-read/cache-write. Summing them
  // is what "tokens this call processed" means; keeping the parts lets the UI
  // explain a cheap call that still moved a lot of tokens.
  const u = envelope.usage || {};
  const num = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
  const inputParts = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  if (inputParts) {
    facts.input_tokens = inputParts;
    if (num(u.cache_read_input_tokens)) facts.cache_read_tokens = u.cache_read_input_tokens;
    if (num(u.cache_creation_input_tokens)) facts.cache_creation_tokens = u.cache_creation_input_tokens;
  }
  if (typeof u.output_tokens === 'number') facts.output_tokens = u.output_tokens;
  return facts;
}

module.exports = { attempt, extractJsonObject, kind: 'claude-cli' };
