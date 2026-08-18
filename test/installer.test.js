'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate ~/.statusline before any src module loads.
const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-inst-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const installer = require('../src/installer');

const FIXTURE = path.join(__dirname, 'fixtures', 'settings.pixel.json');

function freshSettingsCopy() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-set-')), 'settings.json');
  fs.copyFileSync(FIXTURE, file);
  return file;
}

test('exactly the events the fold consumes are registered', () => {
  // Dropping any of these silently stops capture for that event type.
  for (const event of ['UserPromptSubmit', 'Stop', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
    assert.ok(installer.ENTRIES.some((e) => e.event === event), `${event} hook missing`);
  }
  // Notification was only ever registered for the attention beep, which now
  // ships as its own plugin. Nothing in the fold reads it, so forwarding it
  // spooled an event no one consumed on every permission prompt and idle nudge.
  assert.ok(
    !installer.ENTRIES.some((e) => e.event === 'Notification'),
    'Notification is the beep plugin\'s to register, not ours'
  );
});

test('installing prunes our own entries this version no longer registers', () => {
  const file = freshSettingsCopy();
  installer.install(file);

  // Simulate an install from a version that still forwarded Notification, with
  // a third-party hook sharing the group.
  const withStale = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ourCommand = installer.status(file).hookCommand;
  withStale.hooks.Notification = [
    { hooks: [{ type: 'command', command: ourCommand, timeout: 10, async: true }] },
    { hooks: [{ type: 'command', command: 'node C:/other/vendor-hook.js' }] },
  ];
  fs.writeFileSync(file, JSON.stringify(withStale, null, 2));

  const res = installer.install(file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(res.pruned, [{ event: 'Notification', matcher: null }]);
  assert.strictEqual(after.hooks.Notification.length, 1, 'our stale group is gone');
  assert.strictEqual(
    after.hooks.Notification[0].hooks[0].command,
    'node C:/other/vendor-hook.js',
    'a third-party hook on the same event is untouched'
  );
  assert.strictEqual(installer.status(file).fullyInstalled, true, 'our real entries survive the prune');
});

test('pruning never touches a group we do not own', () => {
  const file = freshSettingsCopy();
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  installer.install(file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const event of Object.keys(before.hooks)) {
    const beforeArr = before.hooks[event];
    assert.deepStrictEqual(
      after.hooks[event].slice(0, beforeArr.length), beforeArr,
      `${event} third-party groups altered by the prune`
    );
  }
});

test('install appends only statusline entries and preserves everything else', () => {
  const file = freshSettingsCopy();
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = installer.install(file);
  assert.strictEqual(result.added.length, installer.ENTRIES.length);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));

  // Non-hook keys byte-identical.
  for (const key of Object.keys(before)) {
    if (key === 'hooks') continue;
    assert.deepStrictEqual(after[key], before[key], `top-level key ${key} changed`);
  }
  // Pre-existing hook groups still present, in order, at the front.
  for (const event of Object.keys(before.hooks)) {
    const beforeArr = before.hooks[event];
    const afterArr = after.hooks[event];
    assert.deepStrictEqual(afterArr.slice(0, beforeArr.length), beforeArr, `${event} groups altered`);
  }
  // Our entries present.
  const st = installer.status(file);
  assert.strictEqual(st.fullyInstalled, true);
  // PostToolUse got exactly two of ours appended after the pixel one.
  assert.strictEqual(after.hooks.PostToolUse.length, 3);
});

test('install is idempotent', () => {
  const file = freshSettingsCopy();
  installer.install(file);
  const once = fs.readFileSync(file, 'utf8');
  const second = installer.install(file);
  assert.strictEqual(second.added.length, 0);
  assert.strictEqual(second.skipped.length, installer.ENTRIES.length);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), once);
});

test('uninstall restores the original object exactly', () => {
  const file = freshSettingsCopy();
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  installer.install(file);
  const result = installer.uninstall(file);
  assert.strictEqual(result.removed, installer.ENTRIES.length);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after, before);
  assert.strictEqual(installer.status(file).fullyInstalled, false);
});

test('install creates settings file when absent, uninstall leaves no hooks key', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-set-')), 'settings.json');
  installer.install(file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(after.hooks.UserPromptSubmit.length === 1);
  installer.uninstall(file);
  const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(cleaned, {});
});

test('install refuses to touch corrupt settings', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-set-')), 'settings.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => installer.install(file), /not valid JSON/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('install repoints hooks left by another checkout and reports the drift until it does', () => {
  const file = freshSettingsCopy();
  installer.install(file);

  // Rewrite every one of our entries to an older clone's path, the way a
  // teammate's settings.json looks after the repo moves.
  const other = 'node "C:\\old-clone\\hooks\\hook-forward.js"';
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.command === installer.HOOK_COMMAND) hook.command = other;
      }
    }
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));

  // Reported honestly from settings.json, not from our own manifest, which
  // still claims this checkout.
  const drifted = installer.status(file);
  assert.ok(drifted.fullyInstalled, 'entries are present, just pointing elsewhere');
  assert.deepStrictEqual(drifted.foreignCommands, [other]);
  assert.match(drifted.drift, /different checkout/);

  const res = installer.install(file);
  assert.strictEqual(res.added.length, 0, 'nothing is duplicated');
  assert.strictEqual(res.repointed.length, installer.ENTRIES.length);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const commands = Object.values(after.hooks)
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(!commands.includes(other), 'the stale path is gone');
  assert.strictEqual(installer.status(file).drift, null);
  installer.uninstall(file);
});

test('repointing preserves third-party hooks sharing the group', () => {
  const file = freshSettingsCopy();
  installer.install(file);
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const group = settings.hooks.SessionStart.find((g) =>
    g.hooks.some((h) => h.command === installer.HOOK_COMMAND)
  );
  group.hooks[group.hooks.findIndex((h) => h.command === installer.HOOK_COMMAND)].command =
    'node "/elsewhere/hooks/hook-forward.js"';
  group.hooks.push({ type: 'command', command: 'node "/vendor/other.js"', timeout: 5 });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));

  installer.install(file);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repointedGroup = after.hooks.SessionStart.find((g) =>
    g.hooks.some((h) => h.command === installer.HOOK_COMMAND)
  );
  assert.ok(
    repointedGroup.hooks.some((h) => h.command === 'node "/vendor/other.js"'),
    'a co-located third-party hook survives'
  );
  installer.uninstall(file);
});
