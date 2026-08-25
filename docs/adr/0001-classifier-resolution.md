# Resolve the classifier CLI without relying on PATH

The watcher runs from a LaunchAgent on macOS, which inherits
`/usr/bin:/bin:/usr/sbin:/sbin` rather than the PATH a shell builds from its rc
files, so a PATH lookup alone cannot find a `claude` CLI that every user has
installed. Resolution therefore falls back to the directories Claude Code
installs into, and `doctor` reports what the watcher itself resolved instead of
working it out a second time, because only that process ran in the environment
the answer depends on.

## Considered Options

**Record the absolute path when autostart registers the watcher**, the way the
Node interpreter is already recorded. Rejected because it repairs a machine only
when somebody re-runs `autostart`, and the machines that need it are the ones
whose owners have no reason to suspect anything is wrong.

**Have `doctor` re-resolve against a hardcoded `/usr/bin:/bin:/usr/sbin:/sbin`.**
Rejected because that PATH is the execve default rather than a value the system
publishes: `launchctl getenv PATH` returns empty, so the check would be an
estimate against a constant Apple never promised, and it would still disagree
with a watcher running older code.

## Consequences

`GET /api/health` carries the resolved path, and that field is now a contract
`doctor` depends on. A watcher too old to report it is a diagnosable state of its
own, answered by restarting the watcher rather than by guessing on its behalf.
