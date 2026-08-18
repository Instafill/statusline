'use strict';
// statusline CLI entry point.
//   node src/cli.js install     — add statusline hooks to ~/.claude/settings.json
//   node src/cli.js uninstall   — remove only statusline hooks
//   node src/cli.js autostart   — start the watcher at login (--off, --status)
//   node src/cli.js doctor      — preflight checks with a named fix for each
//   node src/cli.js status      — installer + watcher + data status
//   node src/cli.js start       — run the watcher + local UI
//   node src/cli.js digest <id> — print the digest that WOULD be sent (no egress)
//   node src/cli.js classify <id> — classify one session now (makes one LLM call)
//   node src/cli.js recompute   — recompute project grouping
//   node src/cli.js refold [id] — re-derive state from event logs (all sessions
//                                 or one) — run after a deriveState change
//   node src/cli.js join <url> <code> — enroll this machine with the team
//                                 endpoint (one-time; enables uploads)
const { ensureDirs, paths } = require('./paths');

async function main() {
  const [cmd, arg, arg2] = process.argv.slice(2);
  ensureDirs();
  // Whichever copy is being run is the one the logon launcher should resolve.
  try {
    require('./agent-root').recordAgentRoot();
  } catch (e) {
    /* a read-only or unwritable data dir must not break the command itself */
  }

  switch (cmd) {
    case 'install': {
      const installer = require('./installer');
      const res = installer.install();
      console.log(`Installed ${res.added.length} hook entr${res.added.length === 1 ? 'y' : 'ies'} (${res.skipped.length} already present) in ${res.settingsPath}`);
      if (res.repointed.length) {
        console.log(`Repointed ${res.repointed.length} entr${res.repointed.length === 1 ? 'y' : 'ies'} from another checkout to this one`);
      }
      if (res.pruned.length) {
        console.log(`Removed ${res.pruned.length} entr${res.pruned.length === 1 ? 'y' : 'ies'} this version no longer registers: ${res.pruned.map((p) => p.event).join(', ')}`);
      }
      if (res.backupFile) console.log(`Backup: ${res.backupFile}`);
      console.log('New Claude Code sessions will now be observed. Run "node src/cli.js start" to launch the watcher.');
      break;
    }
    case 'uninstall': {
      const installer = require('./installer');
      const res = installer.uninstall();
      console.log(`Removed ${res.removed} statusline hook entries from ${res.settingsPath}`);
      if (res.backupFile) console.log(`Backup: ${res.backupFile}`);
      break;
    }
    case 'status': {
      const installer = require('./installer');
      const fs = require('fs');
      const http = require('http');
      const config = require('./config');
      const st = installer.status();
      console.log(`Data dir:      ${paths.home}`);
      console.log(`Settings file: ${st.settingsPath}${st.parseError ? ` (PARSE ERROR: ${st.parseError})` : ''}`);
      console.log(`Hooks:         ${st.fullyInstalled ? 'installed' : 'NOT (fully) installed'}`);
      for (const e of st.entries) console.log(`  - ${e.event}${e.matcher ? ` [${e.matcher}]` : ''}: ${e.installed ? 'ok' : 'missing'}`);
      if (st.drift) console.log(`Install drift: ${st.drift} — re-run "node src/cli.js install"`);
      let spoolDepth = 0;
      let sessionCount = 0;
      try {
        spoolDepth = fs.readdirSync(paths.spoolNew).length;
        sessionCount = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith('.json')).length;
      } catch (e) { /* dirs may not exist yet */ }
      console.log(`Spool pending: ${spoolDepth}; sessions on disk: ${sessionCount}`);
      const cfg = config.load();
      await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: cfg.port, path: '/api/health', timeout: 1500 }, (res) => {
          console.log(`Watcher:       running (http://127.0.0.1:${cfg.port})`);
          res.resume();
          resolve();
        });
        req.on('error', () => {
          console.log(`Watcher:       not running (start with "node src/cli.js start")`);
          resolve();
        });
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
      });
      break;
    }
    case 'start': {
      await require('./watcher').start();
      break; // keeps running
    }
    case 'digest': {
      if (!arg) exitUsage('digest requires a session id');
      const sessions = require('./watcher/sessions');
      const config = require('./config');
      const { buildDigest } = require('./digest');
      const { readAssistantExcerpts } = require('./watcher/transcript');
      const s = sessions.foldSession(arg) || sessions.getSession(arg);
      if (!s) exitUsage(`unknown session ${arg}`);
      const cfg = config.load();
      const excerpts = s.transcript_path
        ? readAssistantExcerpts(s.transcript_path, { maxExcerpts: cfg.digest.max_excerpts, maxExcerptChars: cfg.digest.max_excerpt_chars })
        : [];
      const text = buildDigest({ ...s, assistant_excerpts: excerpts }, cfg.digest);
      console.log(text);
      console.error(`\n[${text.length} chars — preview only, nothing was sent]`);
      break;
    }
    case 'classify': {
      if (!arg) exitUsage('classify requires a session id');
      const { classifySessionNow } = require('./classify/run');
      console.error(`Classifying session ${arg} (one LLM call via configured classifier)...`);
      const state = await classifySessionNow(arg, { trigger: 'cli' });
      if (state.classification_state === 'classified') {
        console.log(JSON.stringify(state.classification, null, 2));
      } else {
        console.error(`Classification failed: ${state.classifier_error}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'recompute': {
      const grouping = require('./grouping');
      const out = grouping.recompute();
      console.log(`Recomputed ${out.projects.length} projects.`);
      break;
    }
    case 'refold': {
      // Re-derive session state from the event logs — the supported way to
      // pick up new capture fields (git_main_root, git_origin, …) on sessions
      // with no new activity after a deriveState change. Safe while the
      // watcher runs (folds are atomic and idempotent); repos gone from disk
      // simply keep null git fields. One sid, or all sessions.
      const fs = require('fs');
      const sessions = require('./watcher/sessions');
      const grouping = require('./grouping');
      const sids = arg
        ? [arg]
        : fs
            .readdirSync(paths.sessionsDir)
            .filter((f) => f.endsWith('.events.jsonl'))
            .map((f) => f.replace(/\.events\.jsonl$/, ''));
      let folded = 0;
      for (const sid of sids) {
        if (sessions.foldSession(sid)) folded++;
        else if (arg) exitUsage(`unknown session ${arg}`);
      }
      const out = grouping.recompute();
      console.log(`Re-folded ${folded} session(s) from event logs; regrouped into ${out.projects.length} projects.`);
      console.log('(The uploader re-ships anything whose content changed on its next reconcile.)');
      break;
    }
    case 'join': {
      if (!arg || !arg2) exitUsage('join requires <url> and <enroll-code> — copy the command from your team dashboard');
      const { join } = require('./upload/join');
      const r = await join(arg, arg2);
      console.log(`Enrolled machine ${r.machine_id} with ${r.org ? `"${r.org.name}"` : 'the team'} (${r.endpoint}).`);
      console.log(`Attributed to practitioner ${r.practitioner_id}. Uploads are now enabled.`);
      console.log('If the watcher is running, restart it to start uploading:');
      console.log('  taskkill /PID <pid from ~/.statusline/watcher.lock> /F && node src/cli.js start');
      break;
    }
    case 'autostart': {
      const autostart = require('./autostart');
      if (arg === '--off') {
        const res = autostart.disable();
        console.log(res.removed ? 'Autostart removed. The watcher will no longer start at login.' : 'Autostart was not registered; nothing to remove.');
      } else if (arg === '--status') {
        const st = autostart.status();
        console.log(`Autostart: ${st.enabled ? 'enabled' : 'not enabled'} (${st.mechanism} "${st.id}")`);
      } else {
        const res = autostart.enable();
        if (res.note) console.log(`Note: ${res.note}.`);
        console.log(`Autostart enabled via ${res.mechanism} "${res.id}".`);
        console.log('The watcher will start automatically at login. Disable with "node src/cli.js autostart --off".');
      }
      break;
    }
    case 'doctor': {
      const doctor = require('./doctor');
      const results = await doctor.run({ skipAuth: arg === '--no-auth' });
      const mark = { ok: 'PASS', warn: 'WARN', fail: 'FAIL' };
      for (const r of results) {
        console.log(`[${mark[r.status]}] ${r.name.padEnd(13)} ${r.detail}`);
        if (r.fix && r.status !== doctor.OK) console.log(`         -> ${r.fix}`);
      }
      const failed = results.filter((r) => r.status === doctor.FAIL).length;
      const warned = results.filter((r) => r.status === doctor.WARN).length;
      console.log(`\n${results.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s).`);
      if (failed) process.exitCode = 1;
      break;
    }
    default:
      exitUsage(cmd ? `unknown command "${cmd}"` : null);
  }
}

function exitUsage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Usage: node src/cli.js <command>\n\n' +
      '  install              add statusline hooks to ~/.claude/settings.json\n' +
      '  uninstall            remove only statusline hook entries\n' +
      '  autostart [--off|--status]   run the watcher at login\n' +
      '  doctor [--no-auth]   check the whole setup and name the fix for anything broken\n' +
      '  status               installer + watcher + data status\n' +
      '  start                run the watcher + local UI\n' +
      '  digest <sid>         print the digest that WOULD be sent (no egress)\n' +
      '  classify <sid>       classify one session now (one LLM call)\n' +
      '  recompute            recompute project grouping\n' +
      '  refold [sid]         re-derive state from event logs (all sessions or one)\n' +
      '  join <url> <code>    enroll this machine with the team endpoint (enables uploads)'
  );
  process.exit(msg ? 1 : 0);
}

main().catch((e) => {
  console.error(`statusline: ${e.message}`);
  process.exit(1);
});
