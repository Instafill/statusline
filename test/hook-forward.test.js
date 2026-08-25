'use strict';
// The hook forwarder runs inside every Claude Code session on the machine, so
// its contract (spool the event, stay silent, exit 0) is asserted here by
// spawning the real script — nothing in src/ is involved.
//
// The attention beep moved to plugins/beep/ on 2026-08-17, then to its own
// repo (github.com/ogamaniuk/statusline-beep) on 2026-08-18, where its own
// test suite lives. What matters here is that this script does one thing and
// returns immediately.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { test } = require('node:test');
const assert = require('node:assert');

const TESTROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-hook-'));
const HOOK = path.join(__dirname, '..', 'hooks', 'hook-forward.js');

let n = 0;
function freshHome() {
  const home = path.join(TESTROOT, `home-${++n}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function runHook(home, payload, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, STATUSLINE_HOME: home, ...(extraEnv || {}) };
    delete env.STATUSLINE_SELF;
    if (extraEnv && extraEnv.STATUSLINE_SELF) env.STATUSLINE_SELF = extraEnv.STATUSLINE_SELF;
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function spooled(home) {
  try {
    return fs.readdirSync(path.join(home, 'spool', 'new'));
  } catch (e) {
    return [];
  }
}

function assertClean(res) {
  assert.strictEqual(res.code, 0, 'always exits 0');
  assert.strictEqual(res.stdout, '', 'never prints — Claude Code reads this stream');
  assert.strictEqual(res.stderr, '', 'never writes to stderr either');
}

test('an event is spooled for the watcher', async () => {
  const home = freshHome();
  const res = await runHook(home, { session_id: 's1', hook_event_name: 'Stop' });
  assertClean(res);
  assert.strictEqual(spooled(home).length, 1);
});

test('every observed event type spools', async () => {
  const home = freshHome();
  for (const event of ['UserPromptSubmit', 'Stop', 'PostToolUse', 'SessionStart', 'SessionEnd']) {
    assertClean(await runHook(home, { session_id: 's1', hook_event_name: event }));
  }
  assert.strictEqual(spooled(home).length, 5);
});

test('it returns immediately — nothing is waited on', async () => {
  // The beep used to make this script linger for its player. Now that it is
  // gone, a forwarder that takes any real time means something crept back in.
  const home = freshHome();
  const t0 = Date.now();
  assertClean(await runHook(home, { session_id: 's1', hook_event_name: 'Stop' }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `returned in ${elapsed}ms without waiting on anything`);
});

test('an unparseable payload spools verbatim', async () => {
  const home = freshHome();
  const res = await runHook(home, 'not json at all');
  assertClean(res);
  const files = spooled(home);
  assert.strictEqual(files.length, 1);
  assert.strictEqual(
    fs.readFileSync(path.join(home, 'spool', 'new', files[0]), 'utf8'),
    'not json at all'
  );
});

test('the self-observation guard suppresses the spool entirely', async () => {
  const home = freshHome();
  const res = await runHook(
    home,
    { session_id: 's1', hook_event_name: 'Stop' },
    { STATUSLINE_SELF: '1' }
  );
  assertClean(res);
  assert.strictEqual(spooled(home).length, 0);
});

test('CLAUDE_PID is recorded on the spooled event', async () => {
  const home = freshHome();
  const res = await runHook(
    home,
    { session_id: 's1', hook_event_name: 'Stop' },
    { CLAUDE_PID: '4242' }
  );
  assertClean(res);
  const files = spooled(home);
  const doc = JSON.parse(fs.readFileSync(path.join(home, 'spool', 'new', files[0]), 'utf8'));
  assert.strictEqual(doc._statusline.claude_pid, 4242);
});

test('an empty payload writes nothing and still exits 0', async () => {
  const home = freshHome();
  const res = await runHook(home, '');
  assertClean(res);
  assert.strictEqual(spooled(home).length, 0);
});

test('SessionStart records where the agent is running from', async () => {
  // The only code that always runs from the copy Claude Code actually loaded.
  // After a plugin update lands the agent in a new versioned directory, this
  // is what tells the logon launcher where it went.
  const home = freshHome();
  await runHook(home, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' });
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8'));
  assert.strictEqual(rec.root, path.resolve(__dirname, '..'));
  assert.ok(rec.recorded_at);
});

test('other events leave the agent record alone', async () => {
  const home = freshHome();
  const record = path.join(home, 'agent.json');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ v: 1, root: '/elsewhere' }));
  await runHook(home, { hook_event_name: 'Stop', session_id: 's1' });
  assert.strictEqual(JSON.parse(fs.readFileSync(record, 'utf8')).root, '/elsewhere');
  assert.strictEqual(spooled(home).length, 1, 'the event still spools');
});
