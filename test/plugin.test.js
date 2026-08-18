'use strict';
// The plugin manifests are a second, independent way to install the exact same
// capture. A malformed or drifted manifest does not error — Claude Code simply
// loads nothing, or loads hooks that no longer match what the fold consumes.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-plug-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { ENTRIES } = require('../src/installer');

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const PLUGIN_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/hook-forward.js"';

test('plugin hooks register exactly the entries the installer registers', () => {
  const { hooks } = readJson('hooks/hooks.json');
  const fromPlugin = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      assert.strictEqual(group.hooks.length, 1, `${event}: one hook per group`);
      const h = group.hooks[0];
      assert.strictEqual(h.type, 'command');
      // A bare relative path would resolve against the user's cwd, not the
      // plugin, and the quotes matter: the cache path contains the user name.
      assert.strictEqual(h.command, PLUGIN_COMMAND, `${event}: command`);
      fromPlugin.push([event, group.matcher === undefined ? null : group.matcher, !!h.async, h.timeout]);
    }
  }
  const fromInstaller = ENTRIES.map((e) => [
    e.event,
    e.matcher === undefined ? null : e.matcher,
    !!e.async,
    e.timeout,
  ]);
  // Sorted: the two files may list events in different orders, but the set of
  // (event, matcher, async, timeout) tuples has to be identical or one install
  // mode captures something the other does not.
  const key = (t) => JSON.stringify(t);
  assert.deepStrictEqual(fromPlugin.map(key).sort(), fromInstaller.map(key).sort());
});

test('SessionEnd stays synchronous and tight in the plugin manifest too', () => {
  // It shares a ~1.5s budget with every other SessionEnd hook on the machine,
  // and an async SessionEnd is not delivered before the session is gone.
  const { hooks } = readJson('hooks/hooks.json');
  const h = hooks.SessionEnd[0].hooks[0];
  assert.strictEqual(h.async, undefined);
  assert.strictEqual(h.timeout, 3);
});

test('plugin and marketplace manifests agree with package.json', () => {
  const pkg = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');

  assert.strictEqual(plugin.name, 'statusline');
  assert.strictEqual(plugin.version, pkg.version, 'plugin.json version tracks package.json');

  const entry = market.plugins.find((p) => p.name === 'statusline');
  assert.ok(entry, 'the marketplace lists this plugin');
  assert.strictEqual(entry.source, './', 'one repo is both marketplace and plugin');
  assert.strictEqual(entry.version, pkg.version, 'marketplace version tracks package.json');
  assert.ok(market.owner && market.owner.name, 'owner is required by the marketplace schema');
});

test('the skill ships inside the plugin', () => {
  // Plugins scan skills/ by default; if this moves, /statusline:statusline
  // silently stops existing for every plugin install.
  assert.ok(fs.existsSync(path.join(ROOT, 'skills', 'statusline', 'SKILL.md')));
});
