'use strict';
// Manages statusline hook entries inside the user's ~/.claude/settings.json.
// That file already contains third-party hooks (pixel-agents), statusLine,
// permissions, and other keys — every operation here is strictly additive or
// manifest-scoped, and nothing else in the file is ever modified.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths, claudeSettings, hookScript, ensureDirs } = require('./paths');
const { readJson, writeJsonAtomic } = require('./util/jsonfile');
const { normalizePath } = require('./util/platform');

const HOOK_COMMAND = `node "${hookScript}"`;

// SessionEnd shares a ~1.5s budget across all hooks (raised by explicit
// timeouts), so it gets a tight timeout and no async flag; everything else is
// async so it can never block the user's turn.
const ENTRIES = [
  { event: 'UserPromptSubmit', matcher: undefined, async: true, timeout: 10 },
  { event: 'Stop', matcher: undefined, async: true, timeout: 10 },
  {
    event: 'PostToolUse',
    matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|Read|WebFetch|WebSearch',
    async: true,
    timeout: 10,
  },
  { event: 'PostToolUse', matcher: 'mcp__.*', async: true, timeout: 10 },
  { event: 'SessionStart', matcher: undefined, async: true, timeout: 10 },
  { event: 'SessionEnd', matcher: undefined, async: false, timeout: 3 },
];
// Notification was registered until 2026-08-17 for the attention beep only —
// the fold never consumed it, so every permission prompt and idle nudge spooled
// an event nothing read. The beep now lives in its own repo
// (github.com/ogamaniuk/statusline-beep) with its own hook.

// Fingerprint of the hook set this build expects. Stored in the manifest at
// install time so a teammate who pulls a version with new/changed hook entries
// is told to re-run install instead of silently missing those events.
function entriesSignature() {
  const canonical = JSON.stringify(
    ENTRIES.map((e) => [e.event, e.matcher === undefined ? null : e.matcher, !!e.async, e.timeout])
  );
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function buildGroup(entry) {
  const hook = { type: 'command', command: HOOK_COMMAND, timeout: entry.timeout };
  if (entry.async) hook.async = true;
  const group = {};
  if (entry.matcher !== undefined) group.matcher = entry.matcher;
  group.hooks = [hook];
  return group;
}

function isOurHook(hook, manifestCommand) {
  if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') return false;
  if (manifestCommand && hook.command === manifestCommand) return true;
  // Fallback for orphaned manifests / moved or renamed clones. Keyed on the
  // script path only — never on the checkout's folder name, which differs per
  // teammate and would silently strand hook entries on uninstall.
  return normalizePath(hook.command).includes('/hooks/hook-forward.js');
}

function groupHasOurs(group, manifestCommand) {
  return (
    Array.isArray(group && group.hooks) && group.hooks.some((h) => isOurHook(h, manifestCommand))
  );
}

// Identity of a hook group: the event plus its matcher, encoded so that no
// matcher value can be mistaken for a different event/matcher pair.
function groupKey(event, matcher) {
  return JSON.stringify([event, matcher === undefined ? null : matcher]);
}

function readSettingsStrict(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    return { raw: null, obj: {} }; // no settings file yet — we'll create one
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${settingsPath} is not valid JSON (${e.message}). Refusing to touch it — fix the file manually first.`,
      { cause: e }
    );
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error(`${settingsPath} does not contain a JSON object. Refusing to touch it.`);
  }
  return { raw, obj };
}

function backupSettings(settingsPath, raw) {
  if (raw === null) return null;
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(paths.backupsDir, `settings.json.${stamp}.bak`);
  fs.writeFileSync(file, raw);
  return file;
}

function writeSettingsVerified(settingsPath, obj, backupFile, raw) {
  writeJsonAtomic(settingsPath, obj);
  try {
    JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    if (raw !== null) fs.writeFileSync(settingsPath, raw); // restore
    throw new Error(
      `Post-write verification of ${settingsPath} failed and the previous content was restored` +
        (backupFile ? ` (backup also at ${backupFile})` : '') +
        `: ${e.message}`,
      { cause: e }
    );
  }
}

function install(settingsPath = claudeSettings) {
  ensureDirs();
  const { raw, obj } = readSettingsStrict(settingsPath);
  const backupFile = backupSettings(settingsPath, raw);

  if (obj.hooks === undefined) obj.hooks = {};
  if (typeof obj.hooks !== 'object' || obj.hooks === null || Array.isArray(obj.hooks)) {
    throw new Error(`${settingsPath} has a non-object "hooks" key. Refusing to touch it.`);
  }

  const added = [];
  const skipped = [];
  const repointed = [];
  for (const entry of ENTRIES) {
    if (!Array.isArray(obj.hooks[entry.event])) obj.hooks[entry.event] = [];
    const arr = obj.hooks[entry.event];
    const group = arr.find(
      (g) => g && g.matcher === entry.matcher && groupHasOurs(g, HOOK_COMMAND)
    );
    if (!group) {
      arr.push(buildGroup(entry));
      added.push(entry);
      continue;
    }
    // An entry left by another checkout of this repo — a second clone, a moved
    // directory, an upgrade that changed a timeout — must be rewritten to point
    // here. Skipping it is what made a re-clone silently keep capturing through
    // the old (often deleted) path while install and doctor both reported
    // success.
    const fresh = buildGroup(entry).hooks[0];
    let changed = false;
    group.hooks = group.hooks.map((h) => {
      if (!isOurHook(h, HOOK_COMMAND)) return h;
      if (h.command === fresh.command && h.timeout === fresh.timeout && !!h.async === !!fresh.async)
        return h;
      changed = true;
      return { ...fresh };
    });
    (changed ? repointed : skipped).push(entry);
  }

  // Drop our own entries this build no longer registers (a dropped event, or a
  // changed matcher). Without this an upgrade strands orphaned hooks that keep
  // forwarding events nothing consumes — which is exactly what retiring
  // Notification would have left behind on every existing install. Scoped the
  // same way uninstall is: a group is only ever touched when one of ITS hooks
  // is ours, and third-party hooks sharing that group are preserved.
  const wanted = new Set(ENTRIES.map((e) => groupKey(e.event, e.matcher)));
  const pruned = [];
  for (const event of Object.keys(obj.hooks)) {
    const arr = obj.hooks[event];
    if (!Array.isArray(arr)) continue;
    const kept = [];
    for (const group of arr) {
      // groupHasOurs tolerates a malformed/null group, so it gates the rest.
      if (!groupHasOurs(group, HOOK_COMMAND) || wanted.has(groupKey(event, group.matcher))) {
        kept.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((h) => !isOurHook(h, HOOK_COMMAND));
      pruned.push({ event, matcher: group.matcher === undefined ? null : group.matcher });
      if (keptHooks.length > 0) kept.push({ ...group, hooks: keptHooks });
    }
    if (kept.length > 0) obj.hooks[event] = kept;
    else delete obj.hooks[event];
  }

  writeSettingsVerified(settingsPath, obj, backupFile, raw);

  writeJsonAtomic(paths.manifest, {
    v: 1,
    command: HOOK_COMMAND,
    signature: entriesSignature(),
    settings_path: settingsPath,
    installed_at: new Date().toISOString(),
    entries: ENTRIES.map((e) => ({
      event: e.event,
      matcher: e.matcher === undefined ? null : e.matcher,
    })),
  });

  return { added, skipped, repointed, pruned, backupFile, settingsPath };
}

function uninstall(settingsPath = claudeSettings) {
  const manifest = readJson(paths.manifest, null);
  const manifestCommand = manifest ? manifest.command : null;
  const { raw, obj } = readSettingsStrict(settingsPath);
  if (raw === null) return { removed: 0, settingsPath }; // nothing to do

  const backupFile = backupSettings(settingsPath, raw);
  let removed = 0;

  if (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)) {
    for (const event of Object.keys(obj.hooks)) {
      const arr = obj.hooks[event];
      if (!Array.isArray(arr)) continue;
      const kept = [];
      for (const group of arr) {
        if (!group || !Array.isArray(group.hooks)) {
          kept.push(group);
          continue;
        }
        const keptHooks = group.hooks.filter((h) => {
          const ours = isOurHook(h, manifestCommand);
          if (ours) removed++;
          return !ours;
        });
        if (keptHooks.length > 0) kept.push({ ...group, hooks: keptHooks });
        // groups left with zero hooks are dropped entirely
      }
      if (kept.length > 0) obj.hooks[event] = kept;
      else delete obj.hooks[event];
    }
    if (Object.keys(obj.hooks).length === 0) delete obj.hooks;
  }

  writeSettingsVerified(settingsPath, obj, backupFile, raw);
  try {
    fs.unlinkSync(paths.manifest);
  } catch (e) {
    // manifest may not exist; fine
  }
  return { removed, backupFile, settingsPath };
}

function status(settingsPath = claudeSettings) {
  const manifest = readJson(paths.manifest, null);
  const manifestCommand = manifest ? manifest.command : null;
  let obj = {};
  let parseError = null;
  try {
    obj = readSettingsStrict(settingsPath).obj;
  } catch (e) {
    parseError = e.message;
  }
  const foreign = new Set();
  const entries = ENTRIES.map((entry) => {
    const arr = (obj.hooks && obj.hooks[entry.event]) || [];
    const group = Array.isArray(arr)
      ? arr.find(
          (g) =>
            g && g.matcher === entry.matcher && groupHasOurs(g, manifestCommand || HOOK_COMMAND)
        )
      : null;
    // Which checkout this entry actually runs matters more than which one the
    // manifest claims: the manifest is ours to rewrite, settings.json is the
    // thing Claude Code executes.
    if (group) {
      for (const h of group.hooks) {
        if (isOurHook(h, manifestCommand || HOOK_COMMAND) && h.command !== HOOK_COMMAND)
          foreign.add(h.command);
      }
    }
    return {
      event: entry.event,
      matcher: entry.matcher === undefined ? null : entry.matcher,
      installed: Boolean(group),
    };
  });
  const fullyInstalled = entries.every((e) => e.installed);
  return {
    settingsPath,
    parseError,
    hookCommand: HOOK_COMMAND,
    manifest,
    entries,
    fullyInstalled,
    foreignCommands: [...foreign],
    drift: driftReason(manifest, fullyInstalled, [...foreign]),
  };
}

// Why the current install is stale, or null when it is up to date. Checked on
// watcher start so a pulled-but-not-reinstalled clone is visible immediately.
function driftReason(manifest, fullyInstalled, foreignCommands = []) {
  if (!fullyInstalled) return 'hooks are not fully installed';
  if (foreignCommands.length) {
    return `hooks point at a different checkout (${foreignCommands[0]}) than this one`;
  }
  if (!manifest) return 'no install manifest — hooks were installed by another checkout';
  if (manifest.command !== HOOK_COMMAND) {
    return `hooks point at a different checkout (${manifest.command}) than this one`;
  }
  if (manifest.signature !== entriesSignature()) {
    return 'the hook set changed since install';
  }
  return null;
}

module.exports = {
  install,
  uninstall,
  status,
  driftReason,
  entriesSignature,
  ENTRIES,
  HOOK_COMMAND,
};
