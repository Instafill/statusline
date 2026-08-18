'use strict';
// Registers the watcher to start at login, so a teammate never has to remember
// to keep a terminal open. Hooks spool events regardless, but without a running
// watcher nothing is ingested or classified — which reads as "statusline is
// broken". Per-user only: no admin/sudo, no system-wide daemon.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { paths } = require('./paths');
const { isWindows, isMac, resolveCommand, autostartTarget } = require('./util/platform');
const { recordAgentRoot, writeLauncher } = require('./agent-root');

// Never the current checkout's own cli.js: a plugin update lands in a new
// versioned directory, so the registered command has to resolve the agent at
// launch time rather than at install time. writeLauncher() puts that indirection
// in the data dir, which never moves.
const cliScript = paths.launcher;

function nodeExe() {
  return resolveCommand('node') || process.execPath;
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return { ok: res.status === 0, status: res.status, out };
}

// ---------------------------------------------------------------- Windows ---
// Scheduled Task at logon. Chosen over a Startup-folder shortcut because it
// runs hidden, survives a missing shell, and can be queried programmatically.
function windowsEnable(target) {
  const command = `"${nodeExe()}" "${cliScript}" start`;
  const res = run('schtasks', [
    '/Create',
    '/TN', target.name,
    '/TR', command,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/F', // replace an existing definition
  ]);
  if (res.ok) return { mechanism: 'Scheduled Task', id: target.name, command };

  // Corporate policy commonly denies task creation. The Startup folder is a
  // plain file write in the user's own profile and needs no rights.
  try {
    writeStartupLauncher(target);
    return {
      mechanism: 'Startup folder launcher',
      id: target.startupFile,
      command,
      note: `Scheduled Task creation was denied (${res.out.replace(/\s+/g, ' ').trim()}), used the Startup folder instead`,
    };
  } catch (e) {
    throw new Error(`schtasks failed (${res.out}) and the Startup folder fallback also failed: ${e.message}`);
  }
}

// A .vbs launcher rather than .cmd: WScript.Shell.Run with window style 0 starts
// the watcher with no console window flashing at every logon.
function writeStartupLauncher(target) {
  fs.mkdirSync(path.dirname(target.startupFile), { recursive: true });
  const vbs = [
    "' statusline — starts the Claude Code capability watcher at logon.",
    "' Remove this file (or run: node src\\cli.js autostart --off) to disable.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${nodeExe()}"" ""${cliScript}"" start", 0, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(target.startupFile, vbs);
}

function windowsDisable(target) {
  let removed = false;
  const res = run('schtasks', ['/Delete', '/TN', target.name, '/F']);
  if (res.ok) removed = true;
  else if (!/cannot find|does not exist|access is denied/i.test(res.out)) {
    throw new Error(`schtasks /Delete failed: ${res.out}`);
  }
  try {
    if (fs.existsSync(target.startupFile)) {
      fs.unlinkSync(target.startupFile);
      removed = true;
    }
  } catch (e) {
    throw new Error(`could not remove ${target.startupFile}: ${e.message}`);
  }
  return { removed };
}

function windowsStatus(target) {
  const res = run('schtasks', ['/Query', '/TN', target.name]);
  if (res.ok) return { enabled: true, mechanism: 'Scheduled Task', id: target.name };
  if (fs.existsSync(target.startupFile)) {
    return { enabled: true, mechanism: 'Startup folder launcher', id: target.startupFile };
  }
  return { enabled: false, mechanism: 'Scheduled Task', id: target.name };
}

// ------------------------------------------------------------------ macOS ---
function macPlist(target) {
  const logFile = path.join(paths.home, 'watcher.out.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${target.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExe()}</string>
    <string>${cliScript}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;
}

function macEnable(target) {
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, macPlist(target));
  run('launchctl', ['unload', target.file]); // ignore failure: may not be loaded
  const res = run('launchctl', ['load', target.file]);
  if (!res.ok) throw new Error(`launchctl load failed: ${res.out}`);
  return { mechanism: 'launchd agent', id: target.label, command: target.file };
}

function macDisable(target) {
  run('launchctl', ['unload', target.file]);
  try {
    fs.unlinkSync(target.file);
  } catch (e) {
    return { removed: false };
  }
  return { removed: true };
}

function macStatus(target) {
  if (!fs.existsSync(target.file)) return { enabled: false, mechanism: 'launchd agent', id: target.label };
  const res = run('launchctl', ['list', target.label]);
  return { enabled: res.ok, mechanism: 'launchd agent', id: target.label };
}

// ----------------------------------------------------------------- public ---
// Windows and macOS are the supported platforms. Anywhere else the watcher
// still runs fine — only unattended startup has to be arranged by hand.
const UNSUPPORTED = `automatic startup is only supported on Windows and macOS (this is ${process.platform}) — run "node src/cli.js start" from your own session manager`;

function enable() {
  // Record first: the launcher is useless without the root it resolves, and
  // re-running autostart from a new copy is how a move or update is adopted.
  recordAgentRoot();
  writeLauncher();
  if (isWindows) return windowsEnable(autostartTarget());
  if (isMac) return macEnable(autostartTarget());
  throw new Error(UNSUPPORTED);
}

function disable() {
  if (isWindows) return windowsDisable(autostartTarget());
  if (isMac) return macDisable(autostartTarget());
  return { removed: false };
}

function status() {
  if (isWindows) return windowsStatus(autostartTarget());
  if (isMac) return macStatus(autostartTarget());
  return { enabled: false, mechanism: 'unsupported platform', id: process.platform, unsupported: true };
}

module.exports = { enable, disable, status };
