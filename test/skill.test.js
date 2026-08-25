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
  const offending = body
    .split(/\r?\n/)
    .filter((l) => /node\s+-e/.test(l) && !/Never write inline/.test(l));
  assert.deepStrictEqual(offending, [], 'no runnable `node -e` snippets in the skill');
});

test('sl.js parses, and every documented subcommand exists', () => {
  const usage = spawnSync(process.execPath, [SL], { encoding: 'utf8' });
  assert.strictEqual(usage.status, 2, 'no arguments prints usage and exits 2');
  assert.strictEqual(usage.stderr.includes('Error'), false, usage.stderr);
  for (const cmd of [
    'status',
    'sessions',
    'session',
    'experience',
    'projects',
    'egress',
    'repo',
    'api',
  ]) {
    assert.ok(usage.stderr.includes(cmd), `usage should list ${cmd}`);
  }
  const md = fs.readFileSync(SKILL_MD, 'utf8');
  for (const cmd of [
    'status',
    'sessions',
    'session',
    'experience',
    'projects',
    'egress',
    'repo',
    'api',
  ]) {
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
  const routes = createApi({
    scheduler: { stats: () => ({ queued: [], running: false }) },
    startedAt: new Date().toISOString(),
  });
  const skill = routes['GET /api/status']().skill;

  // The install offer on the landing page is only as good as this path — if it
  // drifts, every new user copies a command that links an empty directory.
  assert.ok(
    fs.existsSync(path.join(skill.source, 'SKILL.md')),
    `source must hold SKILL.md: ${skill.source}`
  );
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
    const routes = createApi({
      scheduler: { stats: () => ({ queued: [], running: false }) },
      startedAt: new Date().toISOString(),
    });
    const skill = routes['GET /api/status']().skill;
    assert.strictEqual(skill.installed, true);
    assert.strictEqual(skill.provided_by, 'plugin');
    assert.strictEqual(skill.command, null, 'nothing to copy — the plugin carries it');
  } finally {
    agentRoot.isPluginInstall = original;
    delete require.cache[require.resolve('../src/server/api')];
  }
});

// Which skill Claude Code actually loads, and whether it is ours. A team
// deployment reports this per machine, so the failure it has to catch is a copy
// somebody made months ago: the client keeps updating, the skill does not, and
// the version column looks perfectly current the whole time.

const skills = require('../src/skill-status');

// A throwaway agent root carrying a skill. Real files, because the whole
// mechanism is a content hash — stubbing fs would test nothing.
function fakeAgent(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-agent-'));
  const dir = path.join(root, 'skills', 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  fs.writeFileSync(path.join(dir, 'sl.js'), '// helper\n');
  return { root, dir };
}

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  return home;
}

test('an unlinked clone reports no skill at all', () => {
  const { root } = fakeAgent('---\nname: statusline\n---\n');
  const state = skills.detect({ root, homeDir: fakeHome() });
  assert.deepStrictEqual(state, {
    installed: false,
    via: 'none',
    sha: null,
    matches_agent: false,
    shadowed: false,
  });
});

test('a linked skill tracks the checkout and is never stale', () => {
  const { root, dir } = fakeAgent('---\nname: statusline\n---\n');
  const home = fakeHome();
  // Junction, not a symlink: on Windows a directory junction is the one link
  // type that does not need an elevated prompt, which is why install offers it.
  fs.symlinkSync(dir, path.join(home, '.claude', 'skills', 'statusline'), 'junction');

  const state = skills.detect({ root, homeDir: home });
  assert.strictEqual(state.via, 'linked');
  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.matches_agent, true);
  assert.strictEqual(state.sha, skills.fingerprint(dir), 'a link fingerprints as its target');
});

test('a copy that has fallen behind reports itself stale', () => {
  const { root } = fakeAgent('---\nname: statusline\n---\nversion two of the skill\n');
  const home = fakeHome();
  const personal = path.join(home, '.claude', 'skills', 'statusline');
  fs.mkdirSync(personal, { recursive: true });
  // What someone gets by copying the directory instead of linking it: frozen at
  // the moment of the copy while the client keeps moving.
  fs.writeFileSync(path.join(personal, 'SKILL.md'), '---\nname: statusline\n---\nversion ONE\n');
  fs.writeFileSync(path.join(personal, 'sl.js'), '// helper\n');

  const state = skills.detect({ root, homeDir: home });
  assert.strictEqual(state.via, 'copied');
  assert.strictEqual(
    state.installed,
    true,
    'a stale skill is still installed — it just is not ours'
  );
  assert.strictEqual(state.matches_agent, false);
});

test('a copy with identical bytes is current but still reported as a copy', () => {
  // It will drift the next time we ship. Same content today, different future.
  const body = '---\nname: statusline\n---\n';
  const { root } = fakeAgent(body);
  const home = fakeHome();
  const personal = path.join(home, '.claude', 'skills', 'statusline');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'SKILL.md'), body);
  fs.writeFileSync(path.join(personal, 'sl.js'), '// helper\n');

  const state = skills.detect({ root, homeDir: home });
  assert.strictEqual(state.via, 'copied');
  assert.strictEqual(state.matches_agent, true);
});

test('a plugin install carries its own skill and never looks stale', () => {
  // isPluginInstall reads the versioned cache path, so the root has to look
  // like a real one.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-plug-'));
  const root = path.join(base, 'plugins', 'cache', 'statusline', 'statusline', '0.3.2');
  const dir = path.join(root, 'skills', 'statusline');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: statusline\n---\n');
  fs.writeFileSync(path.join(dir, 'sl.js'), '// helper\n');

  const state = skills.detect({ root, homeDir: fakeHome() });
  assert.strictEqual(state.via, 'plugin');
  assert.strictEqual(state.matches_agent, true);
  assert.strictEqual(state.shadowed, false);
});

test('a plugin install flags an older personal copy left behind by a clone', () => {
  // Claude Code loads both. The leftover can win, and then the skill in use is
  // not the one the client version claims.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-plug2-'));
  const root = path.join(base, 'plugins', 'cache', 'statusline', 'statusline', '0.3.2');
  fs.mkdirSync(path.join(root, 'skills', 'statusline'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'statusline', 'SKILL.md'),
    '---\nname: statusline\n---\nnew\n'
  );
  fs.writeFileSync(path.join(root, 'skills', 'statusline', 'sl.js'), '// helper\n');

  const home = fakeHome();
  const personal = path.join(home, '.claude', 'skills', 'statusline');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'SKILL.md'), '---\nname: statusline\n---\nOLD\n');
  fs.writeFileSync(path.join(personal, 'sl.js'), '// helper\n');

  assert.strictEqual(skills.detect({ root, homeDir: home }).shadowed, true);
});

test('what the uploader sends carries no paths — only the verdict', () => {
  // The local API's skill status also holds absolute paths and a command
  // containing the user's home directory. None of that may cross the network
  // (rule 2), so the upload projection is built field by field and this test is
  // what keeps it that way when someone extends detect().
  const sent = skills.forUpload();
  assert.deepStrictEqual(Object.keys(sent).sort(), [
    'installed',
    'matches_agent',
    'sha',
    'shadowed',
    'via',
  ]);
  for (const [k, v] of Object.entries(sent)) {
    if (typeof v !== 'string') continue;
    assert.ok(!/[\\/]/.test(v), `${k} must not carry anything path-shaped: ${v}`);
  }
});

test('sl.js is dependency-free, like everything else that ships', () => {
  const src = fs.readFileSync(SL, 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  for (const r of requires) {
    assert.ok(/^(fs|os|path|node:)/.test(r), `unexpected dependency: ${r}`);
  }
});
