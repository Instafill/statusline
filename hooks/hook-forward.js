'use strict';
// statusline hook forwarder. Installed as the command for Claude Code hook
// events; receives the hook payload on stdin and spools it to disk for the
// watcher. Contract: never block, never print, always exit 0 — this script
// runs inside every Claude Code session on the machine.
//
// It does exactly one thing. The attention beep used to live here and was the
// only reason this file read config, spawned a subprocess and lingered before
// exiting; it moved to plugins/beep/ on 2026-08-17, then to its own repo
// (github.com/ogamaniuk/statusline-beep) on 2026-08-18, where it runs on its
// own two events instead of on every event in every session.
//
// Standalone by design: core modules only, no imports from src/ (the repo may
// move or be mid-edit while sessions are running).

if (process.env.STATUSLINE_SELF === '1') process.exit(0);

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const home = process.env.STATUSLINE_HOME || path.join(os.homedir(), '.statusline');
  const tmpDir = path.join(home, 'spool', 'tmp');
  const newDir = path.join(home, 'spool', 'new');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });

  const chunks = [];
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      // A stray UTF-8 BOM would cost us the CLAUDE_PID injection here and make
      // the spooled event unfoldable later. Dropped before either step.
      let data = Buffer.concat(chunks);
      if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.slice(3);
      if (data.length > 0) {
        // Record the owning Claude Code process (CLAUDE_PID is set by Claude
        // Code in hook processes) so the watcher can tell whether the session
        // is still open in a terminal. Reading an env var costs nothing — no
        // process-tree walk. Any surprise in the payload falls back to the
        // verbatim bytes; capturing this must never cost us the event.
        let out = data;
        let parsed = null;
        try {
          const obj = JSON.parse(data.toString('utf8'));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) parsed = obj;
        } catch (e) {
          /* unparseable or oversized — spool exactly what we received */
        }
        try {
          const claudePid = Number(process.env.CLAUDE_PID);
          if (parsed && Number.isInteger(claudePid) && claudePid > 0) {
            parsed._statusline = { claude_pid: claudePid };
            out = Buffer.from(JSON.stringify(parsed), 'utf8');
          }
        } catch (e) {
          /* serialization surprise — spool exactly what we received */
        }
        const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
        const tmpFile = path.join(tmpDir, name);
        fs.writeFileSync(tmpFile, out);
        fs.renameSync(tmpFile, path.join(newDir, name)); // atomic hand-off

        // Keep the recorded agent location honest. This file is the only thing
        // that always runs from the copy Claude Code actually loaded, so after
        // a plugin update — which lands the code in a new versioned directory —
        // it is what tells the logon launcher where the agent went. Cheap and
        // rare: a small read on SessionStart only, a write only when it moved.
        if (parsed && parsed.hook_event_name === 'SessionStart') {
          try {
            const root = path.resolve(__dirname, '..');
            const record = path.join(home, 'agent.json');
            let known = null;
            try {
              known = JSON.parse(fs.readFileSync(record, 'utf8')).root;
            } catch (e) {
              /* absent or unreadable — rewrite it */
            }
            if (known !== root) {
              const tmpRec = path.join(tmpDir, `agent-${process.pid}.json`);
              fs.writeFileSync(tmpRec, JSON.stringify({ v: 1, root, recorded_at: new Date().toISOString() }, null, 2));
              fs.renameSync(tmpRec, record);
            }
          } catch (e) {
            /* never at the cost of the event we just spooled */
          }
        }
      }
    } catch (e) {
      // swallow everything: a full disk or locked file must not surface
    }
    process.exit(0);
  };

  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  // Guard: if stdin never ends (unexpected), bail with whatever arrived.
  setTimeout(finish, 2000);
} catch (e) {
  process.exit(0);
}
