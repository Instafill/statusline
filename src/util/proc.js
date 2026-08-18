'use strict';
// Process liveness, used to tell whether a session's Claude Code process is
// still running (its terminal tab/window is still open).
//
// signal 0 performs the permission/existence check without delivering a
// signal, so this costs one syscall — cheap enough to run per API request and
// safe to call on every poll.

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null; // not recorded / unusable
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user — still alive.
    return e.code === 'EPERM';
  }
}

module.exports = { isAlive };
