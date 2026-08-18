'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate ~/.statusline before anything reads it (sl.js resolves the port from
// the data dir at require time).
const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-skill-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');

const SKILL_DIR = path.join(__dirname, '..', 'skills', 'statusline');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const SL = path.join(SKILL_DIR, 'sl.js');

// A malformed skill fails silently — Claude Code just does not load it, and no
// one notices until someone asks a question it should have answered. These
// tests are the only thing standing between a typo and that.

function frontmatter() {
  const text = fs.readFileSync(SKILL_MD, 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  assert.ok(m, 'SKILL.md must open with a YAML frontmatter block');
  const out = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const listItem = /^\s+-\s+(.+)$/.exec(raw);
    if (listItem && key) {
      out[key] = Array.isArray(out[key]) ? out[key] : [];
      out[key].push(listItem[1].trim());
      continue;
    }
    const kv = /^([a-z-]+):\s*(.*)$/.exec(raw);
    if (kv) {
      key = kv[1];
      out[key] = kv[2] === '' ? [] : kv[2];
    }
  }
  return out;
}

test('SKILL.md declares the frontmatter Claude Code needs to load it', () => {
  const fm = frontmatter();
  assert.strictEqual(fm.name, 'statusline', 'name must match the directory name');
  assert.strictEqual(typeof fm.description, 'string');
  // The description is the ONLY thing the model sees when deciding whether the
  // skill is relevant — a terse one means the skill never fires.
  assert.ok(fm.description.length > 120, 'description must describe when to use the skill');
  assert.strictEqual(fm['user-invocable'], 'true');
  assert.ok(Array.isArray(fm['allowed-tools']) && fm['allowed-tools'].includes('Bash'));
});

test('SKILL.md points at the helper and not at fragile inline node one-liners', () => {
  const body = fs.readFileSync(SKILL_MD, 'utf8');
  assert.ok(body.includes('sl.js'), 'the skill must direct the model to the bundled helper');
  // `node -e` snippets do not survive PowerShell, which strips double quotes
  // out of native-command arguments. Anything with a Windows path or a JSON
  // string mangles silently, so the skill must not teach that pattern.
  const offending = body.split(/\r?\n/).filter((l) => /node\s+-e/.test(l) && !/Never write inline/.test(l));
  assert.deepStrictEqual(offending, [], 'no runnable `node -e` snippets in the skill');
});

test('sl.js parses, and every documented subcommand exists', () => {
  const usage = spawnSync(process.execPath, [SL], { encoding: 'utf8' });
  assert.strictEqual(usage.status, 2, 'no arguments prints usage and exits 2');
  assert.strictEqual(usage.stderr.includes('Error'), false, usage.stderr);
  for (const cmd of ['status', 'sessions', 'session', 'experience', 'projects', 'egress', 'repo', 'api']) {
    assert.ok(usage.stderr.includes(cmd), `usage should list ${cmd}`);
  }
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  for (const cmd of ['status', 'sessions', 'session', 'experience', 'projects', 'egress', 'repo', 'api']) {
    assert.ok(new RegExp('\\|\\s*`' + cmd + '\\b').test(md), `SKILL.md should document ${cmd}`);
  }
});

test('sl.js reports a down watcher instead of crashing', () => {
  // Point at a port nothing can be listening on. Defaulting to 45817 would
  // make this test pass or fail depending on whether the developer happens to
  // have their own watcher running.
  fs.writeFileSync(path.join(TESTHOME, 'config.json'), JSON.stringify({ port: 1 }));
  // The helper must say the watcher is down and exit 3 — a stack trace would
  // send the model hunting for a bug that is not there.
  const r = spawnSync(process.execPath, [SL, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, STATUSLINE_HOME: TESTHOME },
  });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, /watcher is not running/);
});

test('/api/status advertises the skill with a command that points at this checkout', () => {
  const { createApi } = require('../src/server/api');
  const routes = createApi({ scheduler: { stats: () => ({ queued: [], running: false }) }, startedAt: new Date().toISOString() });
  const skill = routes['GET /api/status']().skill;

  // The install offer on the landing page is only as good as this path — if it
  // drifts, every new user copies a command that links an empty directory.
  assert.ok(fs.existsSync(path.join(skill.source, 'SKILL.md')), `source must hold SKILL.md: ${skill.source}`);
  assert.ok(skill.command.includes(process.platform === 'win32' ? 'Junction' : 'ln -s'));
  assert.match(skill.link, /[\\/]\.claude[\\/]skills[\\/]statusline$/);
  assert.strictEqual(typeof skill.installed, 'boolean');
});

test('a plugin install is never told to link the skill it already ships', () => {
  // Following that offer would load the same skill twice — once namespaced by
  // the plugin, once personally.
  const agentRoot = require('../src/agent-root');
  const original = agentRoot.isPluginInstall;
  agentRoot.isPluginInstall = () => true;
  try {
    delete require.cache[require.resolve('../src/server/api')];
    const { createApi } = require('../src/server/api');
    const routes = createApi({ scheduler: { stats: () => ({ queued: [], running: false }) }, startedAt: new Date().toISOString() });
    const skill = routes['GET /api/status']().skill;
    assert.strictEqual(skill.installed, true);
    assert.strictEqual(skill.provided_by, 'plugin');
    assert.strictEqual(skill.command, null, 'nothing to copy — the plugin carries it');
  } finally {
    agentRoot.isPluginInstall = original;
    delete require.cache[require.resolve('../src/server/api')];
  }
});

test('sl.js is dependency-free, like everything else that ships', () => {
  const src = fs.readFileSync(SL, 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of requires) {
    assert.ok(/^(fs|os|path|node:)/.test(r), `unexpected dependency: ${r}`);
  }
});
