'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-git-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { gitInfo, gitRoot } = require('../src/util/gitroot');

const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;

test('main worktree reports a root and no worktree name; a linked worktree reports both', { skip: !haveGit }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-repo-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  // Embedded credentials must never survive into captured state.
  git(repo, 'remote', 'add', 'origin', 'https://alice:s3cret-token@github.com/acme/demo.git');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');

  const main = gitInfo(repo);
  assert.ok(main.root, 'main worktree has a root');
  assert.equal(main.worktree, null, 'the main worktree is not flagged');
  assert.equal(main.main_root, null, 'the main worktree has no separate parent root');
  assert.equal(main.origin, 'https://github.com/acme/demo.git', 'origin captured, credentials stripped');

  const wt = path.join(repo, 'wt', 'feature-x');
  const added = git(repo, 'worktree', 'add', '-q', '-b', 'feature-x', wt);
  assert.equal(added.status, 0, added.stderr);

  const linked = gitInfo(wt);
  assert.equal(linked.worktree, 'feature-x', 'linked worktree is named');
  assert.ok(/feature-x$/.test(linked.root || ''), 'root is the worktree dir, not the main repo');
  assert.equal((linked.main_root || '').toLowerCase(), main.root.toLowerCase(), 'main_root points at the parent repo');
  assert.equal(linked.origin, 'https://github.com/acme/demo.git', 'worktree shares the repo origin');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('non-repo directories yield nothing at all', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-plain-'));
  const info = gitInfo(plain);
  assert.equal(info.worktree, null);
  assert.equal(info.main_root, null);
  assert.equal(info.origin, null);
  assert.equal(gitInfo(null).root, null);
  assert.equal(gitRoot(null), null);
  fs.rmSync(plain, { recursive: true, force: true });
});
