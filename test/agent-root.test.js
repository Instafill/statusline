'use strict';
// Autostart resolves the agent through the data dir instead of a path baked in
// at install time. If that indirection breaks, nothing errors — the watcher
// just never starts at login, which reads as "statusline stopped working".
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-root-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { paths } = require('../src/paths');
const { AGENT_ROOT, readAgentRoot, recordAgentRoot, isPluginInstall, writeLauncher } = require('../src/agent-root');

test('the recorded root is this copy, and re-recording a move overwrites it', () => {
  recordAgentRoot();
  assert.strictEqual(readAgentRoot().root, AGENT_ROOT);
  assert.strictEqual(AGENT_ROOT, path.resolve(__dirname, '..'));

  recordAgentRoot('/somewhere/else');
  assert.strictEqual(readAgentRoot().root, '/somewhere/else');
  recordAgentRoot();
  assert.strictEqual(readAgentRoot().root, AGENT_ROOT, 'the copy that runs wins');
});

test('a plugin cache path is recognized, a checkout is not', () => {
  // Plugin installs are managed by Claude Code: their hooks come from the
  // plugin manifest and their directory is versioned, so the drift and
  // settings.json checks have to stand down.
  assert.ok(isPluginInstall(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'statusline', 'statusline', '0.2.0')));
  assert.ok(isPluginInstall('/home/u/.claude/plugins/cache/statusline/statusline/0.2.0'));
  assert.ok(!isPluginInstall('C:\work\statusline'));
  assert.ok(!isPluginInstall('/home/u/src/statusline'));
});

test('the launcher lives in the data dir and starts whatever root is recorded', () => {
  const file = writeLauncher();
  assert.strictEqual(file, paths.launcher);
  assert.strictEqual(path.dirname(file), paths.home, 'the one path autostart may embed never moves');

  // Point it at a stand-in "agent" and prove the launcher execs that copy's
  // cli.js with the start argument.
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-fake-'));
  fs.mkdirSync(path.join(fakeRoot, 'src'));
  fs.writeFileSync(
    path.join(fakeRoot, 'src', 'cli.js'),
    'console.log("started:" + process.argv.slice(2).join(","));\n'
  );
  recordAgentRoot(fakeRoot);
  const out = execFileSync(process.execPath, [file], {
    encoding: 'utf8',
    env: { ...process.env, STATUSLINE_HOME: TESTHOME },
  });
  assert.match(out, /started:start/);
});

test('a recorded root that no longer exists fails loudly instead of hanging', () => {
  writeLauncher();
  recordAgentRoot(path.join(os.tmpdir(), 'statusline-does-not-exist'));
  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [paths.launcher], {
      encoding: 'utf8',
      env: { ...process.env, STATUSLINE_HOME: TESTHOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status;
    stderr = e.stderr;
  }
  assert.strictEqual(status, 1);
  assert.match(stderr, /recorded agent is gone/);
  recordAgentRoot();
});
