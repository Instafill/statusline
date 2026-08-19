'use strict';
// Which `/statusline` skill Claude Code will actually load on this machine, and
// whether it is the one this copy of the agent ships.
//
// Those are two different questions, and the answer drifts. The running client
// reports its own version on every upload, but the skill can be a copy someone
// made months ago: the watcher updates, the skill does not, and nothing says so.
// A clone install has to link the directory by hand, so it can also be missing
// entirely — that person can never ask Claude about their own work, and from the
// outside they look perfectly healthy.
//
// The comparison has to happen here, because this is the only place that holds
// both copies: the one Claude Code loads and the one we ship.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Called through the module object, not destructured: `isPluginInstall` is
// monkey-patched by test/skill.test.js, and a destructured binding would keep
// pointing at the original.
const agentRoot = require('./agent-root');

// The two files that ARE the skill. Change either and Claude Code loads
// something different, so both feed the fingerprint.
const FILES = ['SKILL.md', 'sl.js'];
const MEMO_MS = 60 * 1000;

const shippedDir = (root) => path.join(root, 'skills', 'statusline');
const personalDir = (home) => path.join(home, '.claude', 'skills', 'statusline');

// A short content hash of a skill directory, or null when there is no skill
// there. Deliberately truncated: this is an equality check meant to be read off
// a table by a human, not a security claim.
function fingerprint(dir) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(dir, f));
    } catch (e) {
      return null; // missing or unreadable — not a skill
    }
    h.update(f).update(buf);
  }
  return h.digest('hex').slice(0, 12);
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    return null;
  }
}

// The overrides exist for tests: without them this reads the developer's real
// ~/.claude, so the result would depend on how the machine running the suite
// happens to be set up.
function detect({ root = agentRoot.AGENT_ROOT, homeDir = os.homedir() } = {}) {
  const shippedSha = fingerprint(shippedDir(root));
  const personalSha = fingerprint(personalDir(homeDir));

  if (agentRoot.isPluginInstall(root)) {
    // Claude Code scans the plugin's own skills/ directory, so the skill it
    // loads IS this copy — there is nothing to compare it against. What can
    // still be wrong is a personal copy left behind by an earlier clone
    // install: Claude Code sees both, and the stale one can win.
    return {
      installed: Boolean(shippedSha),
      via: 'plugin',
      sha: shippedSha,
      matches_agent: Boolean(shippedSha),
      shadowed: Boolean(personalSha && personalSha !== shippedSha),
    };
  }

  if (!personalSha) {
    return { installed: false, via: 'none', sha: null, matches_agent: false, shadowed: false };
  }

  const matches = Boolean(shippedSha) && personalSha === shippedSha;
  // A link tracks the checkout forever; a copy is frozen at the moment it was
  // made. They can hold identical bytes today and still have different futures,
  // which is the whole reason this distinction is worth reporting.
  const there = realpath(personalDir(homeDir));
  const here = realpath(shippedDir(root));
  const via = there && here ? (there === here ? 'linked' : 'copied') : matches ? 'linked' : 'copied';

  return { installed: true, via, sha: personalSha, matches_agent: matches, shadowed: false };
}

let memo = null;

// THE ONLY SHAPE THAT CROSSES THE NETWORK. Built field by field on purpose:
// the local API's skill status also carries absolute paths and a shell command
// containing the user's home directory, and none of that is ours to upload
// (rule 2). A spread here would leak all of it the first time someone extends
// detect().
//
// Memoized for 60s because this rides every upload flush, not just the 5-minute
// heartbeat — the same staleness contract the reconcile scan uses.
function forUpload() {
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const d = detect();
  const value = {
    installed: d.installed,
    via: d.via,
    sha: d.sha,
    matches_agent: d.matches_agent,
    shadowed: d.shadowed,
  };
  memo = { at: Date.now(), value };
  return value;
}

function resetMemo() {
  memo = null;
}

module.exports = { FILES, fingerprint, detect, forUpload, resetMemo, shippedDir, personalDir };
