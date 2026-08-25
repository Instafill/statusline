'use strict';
// Small cross-platform shims. statusline started as a Windows MVP; these are the
// only places where Windows and macOS genuinely differ.
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Resolve a bare command name to an absolute executable path. Returns null when
// the command is not on PATH; callers fall back to the bare name and let spawn
// report the failure.
function resolveCommand(name) {
  try {
    const finder = isWindows ? 'where.exe' : 'which';
    const res = spawnSync(finder, [name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (res.status !== 0 || !res.stdout) return null;
    const lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (!isWindows) return lines[0];
    // On Windows prefer a real executable over a .cmd/.ps1 shim, which spawn
    // cannot execute directly without a shell.
    return lines.find((l) => l.toLowerCase().endsWith('.exe')) || lines[0];
  } catch (e) {
    return null;
  }
}

// Options that give a child its own process group, so the whole tree can be
// signalled at once. On Windows the group comes from taskkill /T instead.
function detachOptions() {
  return isWindows ? {} : { detached: true };
}

// Best-effort kill of a child and everything it spawned.
function killTree(pid) {
  if (!pid) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        timeout: 10000,
        windowsHide: true,
      });
    } else {
      // Negative pid targets the process group created by detached: true.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (e) {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch (e) {
    /* best effort — the child may already be gone */
  }
}

// Normalize a filesystem path for comparison: forward slashes, lowercased on
// the case-insensitive platforms. Used to recognize our own hook command.
function normalizePath(p) {
  const s = String(p).replace(/\\/g, '/');
  return isWindows || isMac ? s.toLowerCase() : s;
}

// Where a per-user autostart definition lives on each platform.
function autostartTarget() {
  const home = os.homedir();
  if (isWindows) {
    // Two mechanisms: a Scheduled Task where policy allows it, else a launcher
    // in the per-user Startup folder, which needs no special rights at all.
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const startupDir = path.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup'
    );
    return {
      kind: 'schtasks',
      name: 'statusline-watcher',
      startupFile: path.join(startupDir, 'statusline.vbs'),
    };
  }
  if (isMac) {
    return {
      kind: 'launchd',
      label: 'net.statusline.watcher',
      file: path.join(home, 'Library', 'LaunchAgents', 'net.statusline.watcher.plist'),
    };
  }
  return { kind: 'unsupported' }; // autostart is Windows + macOS only
}

module.exports = {
  isWindows,
  isMac,
  resolveCommand,
  detachOptions,
  killTree,
  normalizePath,
  autostartTarget,
};
