'use strict';
// A plugin install must never write hook entries into settings.json: Claude
// Code already registers the plugin's hooks from its manifest, so a second
// registration runs hook-forward twice per event and silently doubles every
// count in the data. `install` refuses and `status` reports the plugin shape
// instead of "drift — re-run install" (which was the advice that led there).
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-pig-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CLI = path.join(REPO, 'src', 'cli.js');

// isPluginInstall() keys on the agent root's path shape, so a copy of the CLI
// under a plugin-cache-shaped directory exercises the real predicate.
function pluginCopy() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-plugincache-'));
  const dest = path.join(root, '.claude', 'plugins', 'cache', 'statusline', 'statusline', '9.9.9');
  for (const rel of ['src', 'hooks']) {
    fs.cpSync(path.join(REPO, rel), path.join(dest, rel), { recursive: true });
  }
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(dest, 'package.json'));
  return dest;
}

function run(root, ...args) {
  return execFileSync(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, STATUSLINE_HOME: process.env.STATUSLINE_HOME },
  });
}

test('isPluginInstall recognizes a plugin-cache root and not a clone', () => {
  const { isPluginInstall } = require('../src/agent-root');
  assert.strictEqual(
    isPluginInstall(path.join('C:', 'Users', 'x', '.claude', 'plugins', 'cache', 'statusline', 'statusline', '0.3.0')),
    true
  );
  assert.strictEqual(isPluginInstall(path.join('C:', 'work', 'statusline', 'agent')), false);
});

test('install from a plugin root refuses and writes no settings.json entries', () => {
  const root = pluginCopy();
  const out = run(root, 'install');
  assert.match(out, /plugin install/i);
  assert.match(out, /double-capture/i);
  const settings = path.join(os.homedir(), '.claude', 'settings.json');
  const before = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
  run(root, 'install'); // idempotent refusal, still no writes
  const after = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
  assert.strictEqual(after, before, 'the real settings.json must not be touched by a refused install');
});

test('status from a plugin root reports the plugin shape, never "re-run install"', () => {
  const out = run(pluginCopy(), 'status');
  assert.match(out, /from the plugin manifest/i);
  assert.doesNotMatch(out, /re-run "node src\/cli\.js install"/);
});

test('status from a clone still reports settings.json hook entries', () => {
  const out = run(REPO, 'status');
  assert.match(out, /^Hooks: +(installed|NOT \(fully\) installed)/m);
});
