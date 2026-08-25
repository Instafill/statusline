'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const cache = new Map();

// Best-effort: one `git rev-parse` per directory yielding the repo root and, if
// the directory belongs to a *linked* worktree, that worktree's name plus the
// main worktree's root (so grouping can fold the worktree into its parent repo).
// A linked worktree has its own git dir (`.git/worktrees/<name>`) while sharing
// the main repo's common dir — equal paths mean the ordinary main worktree.
// A second (memoized) call captures the credential-stripped origin URL.
function gitInfo(cwd) {
  if (!cwd || typeof cwd !== 'string')
    return { root: null, worktree: null, main_root: null, origin: null };
  if (cache.has(cwd)) return cache.get(cwd);
  let info = { root: null, worktree: null, main_root: null, origin: null };
  try {
    const res = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'],
      {
        timeout: 3000,
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    if (res.status === 0 && res.stdout) {
      const [top, gitDir, commonDir] = res.stdout.trim().split(/\r?\n/);
      if (top) info.root = win(top);
      // git prints these relative to cwd when it can (plain `.git`).
      const abs = (p) => (p ? path.resolve(cwd, p) : null);
      const g = abs(gitDir);
      const c = abs(commonDir);
      if (g && c && win(g).toLowerCase() !== win(c).toLowerCase()) {
        info.worktree = path.basename(g);
        // The common dir of a linked worktree is the main repo's `<root>\.git`;
        // anything else (bare repos, odd layouts) stays null and folds nowhere.
        if (path.basename(c) === '.git') info.main_root = win(path.dirname(c));
      }
    }
    if (info.root) {
      const org = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
        timeout: 3000,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (org.status === 0 && org.stdout) {
        const url = org.stdout.trim();
        // Never store embedded credentials (https://user:token@host/...).
        if (url) info.origin = url.replace(/\/\/[^@/]+@/, '//');
      }
    }
  } catch (e) {
    info = { root: null, worktree: null, main_root: null, origin: null };
  }
  cache.set(cwd, info);
  return info;
}

function win(p) {
  return p.replace(/\//g, '\\');
}

// Returns the git repo root for a directory, or null.
function gitRoot(cwd) {
  return gitInfo(cwd).root;
}

module.exports = { gitRoot, gitInfo };
