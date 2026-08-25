'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-upl-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureDirs, paths } = require('../src/paths');
const spool = require('../src/watcher/spool');
const config = require('../src/config');
const { createUploader } = require('../src/upload');

ensureDirs();
const SPOOL_NEW = path.join(TESTHOME, 'spool', 'new');

let seq = 0;
function spoolEvent(payload, tsMs) {
  const name = `${tsMs}-1234-up${String(seq++).padStart(4, '0')}.json`;
  fs.writeFileSync(path.join(SPOOL_NEW, name), JSON.stringify(payload));
}

const SID = 'upload-test-session-1';
const BASE = {
  session_id: SID,
  transcript_path: 'C:\\nope\\t.jsonl',
  cwd: 'C:\\proj\\demo',
  permission_mode: 'default',
};
const T0 = 1755100000000;

// ---- mock ingest endpoint (in-process; NO real network leaves the machine) --
let server;
let port;
let respondWith = 200;
let respondBody = null; // override the ACK payload (e.g. to carry team_config)
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(respondWith, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(respondBody || { ok: respondWith === 200 }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  config.save({
    upload: {
      enabled: true,
      endpoint: `http://127.0.0.1:${port}/v1/ingest`,
      token: 'team-secret',
      debounce_ms: 50,
    },
  });

  spoolEvent({ ...BASE, hook_event_name: 'SessionStart', source: 'startup' }, T0);
  spoolEvent(
    { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'build the widget' },
    T0 + 1000
  );
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    },
    T0 + 2000
  );
  spoolEvent({ ...BASE, hook_event_name: 'Stop', stop_hook_active: false }, T0 + 3000);
  spoolEvent({ ...BASE, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, T0 + 4000);
  spool.drainOnce();
});

after(() => server.close());

const SCHED_STATS = { queued: [], running: false, consecutiveAuthErrors: 0 };
function makeUploader() {
  return createUploader({
    getSchedulerStats: () => SCHED_STATS,
    startedAt: new Date(T0).toISOString(),
  });
}

function egressLines() {
  try {
    return fs
      .readFileSync(paths.egress, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

test('flush posts the full envelope with identity, snapshots, and bearer token', async () => {
  const u = makeUploader();
  u.markDirty(SID);
  await u.flush();

  assert.strictEqual(received.length, 1);
  const { auth, body } = received[0];
  assert.strictEqual(auth, 'Bearer team-secret');
  assert.strictEqual(body.v, 1);
  // machine identity: persisted UUID + fresh host facts
  assert.match(body.machine.machine_id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(body.machine.hostname, os.hostname());
  assert.strictEqual(body.machine.platform, process.platform);
  const onDisk = JSON.parse(fs.readFileSync(paths.machine, 'utf8'));
  assert.strictEqual(onDisk.machine_id, body.machine.machine_id);
  // watcher heartbeat block rides along
  assert.strictEqual(body.watcher.pid, process.pid);
  assert.ok(body.watcher.sessions_total >= 1);
  // the session doc is the state plus snapshots — ALWAYS content-stripped
  // (hard rule 2026-08-17: prompt text never uploads)
  assert.strictEqual(body.sessions.length, 1);
  const doc = body.sessions[0];
  assert.strictEqual(doc.session_id, SID);
  assert.strictEqual(doc.counts.prompts, 1, 'counts survive the strip');
  assert.deepStrictEqual(doc.prompts, [], 'prompt text never uploads');
  assert.strictEqual(doc.live, false); // SessionEnd arrived → never live
  assert.ok(doc.outlook && typeof doc.outlook.kind === 'string');
  assert.ok(doc.uploaded_at);

  // success recorded in egress.jsonl
  const up = egressLines().filter((e) => e.kind === 'upload');
  assert.strictEqual(up.length, 1);
  assert.strictEqual(up[0].outcome, 'ok');
  assert.strictEqual(up[0].session_count, 1);
  assert.deepStrictEqual(up[0].session_ids, [SID]);
  assert.ok(up[0].bytes > 500);

  // sha acknowledged on disk
  const st = JSON.parse(fs.readFileSync(paths.uploadState, 'utf8'));
  assert.ok(st.uploaded[SID].sha.length === 64);
});

test('unchanged session is not re-uploaded; new events trigger re-upload', async () => {
  const u = makeUploader();
  const posts = received.length;
  u.markDirty(SID);
  await u.flush();
  assert.strictEqual(received.length, posts, 'sha-identical doc was re-uploaded');

  spoolEvent({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'one more thing' }, T0 + 5000);
  spool.drainOnce();
  u.markDirty(SID);
  await u.flush();
  assert.strictEqual(received.length, posts + 1);
  assert.strictEqual(received.at(-1).body.sessions[0].counts.prompts, 2);
});

test('a correction label alone re-ships the doc and rides it to the server', async () => {
  // Corrections must reach the team view or it lies: labeling a session
  // `ignore` locally has to drop it from cloud projects/experience too. The
  // correction snapshot is part of the doc sha, so reconcile — no new events —
  // must detect the change and re-upload.
  const grouping = require('../src/grouping');
  const u = makeUploader();
  const posts = received.length;
  grouping.setSessionLabel(SID, 'ignore');
  u.reconcile();
  await u.flush();
  assert.strictEqual(received.length, posts + 1, 'label change alone must re-upload');
  assert.deepStrictEqual(received.at(-1).body.sessions[0].correction, {
    label: 'ignore',
    field_overrides: null,
  });

  // Clearing the label re-ships once more, with the correction gone.
  grouping.setSessionLabel(SID, null);
  u.reconcile();
  await u.flush();
  assert.strictEqual(received.length, posts + 2);
  assert.strictEqual(received.at(-1).body.sessions[0].correction, null);
});

test('reconcile re-derives the dirty set from disk (no in-memory state needed)', async () => {
  spoolEvent(
    { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'change after restart' },
    T0 + 6000
  );
  spool.drainOnce();
  const fresh = makeUploader(); // simulates a watcher restart: empty dirty set
  const posts = received.length;
  fresh.reconcile();
  await fresh.flush();
  assert.strictEqual(received.length, posts + 1);
});

test('server error keeps the session dirty, logs the outcome, and backs off', async () => {
  spoolEvent({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'while broken' }, T0 + 7000);
  spool.drainOnce();
  respondWith = 500;
  const u = makeUploader();
  u.markDirty(SID);
  await u.flush();
  assert.strictEqual(egressLines().at(-1).outcome, 'http_500');
  // no ack written for the failed doc
  const st = JSON.parse(fs.readFileSync(paths.uploadState, 'utf8'));
  const postsAfterFail = received.length;
  // backoff: an immediate retry does not hit the server
  await u.flush();
  assert.strictEqual(received.length, postsAfterFail);

  // recovery after restart (fresh instance, server healthy again)
  respondWith = 200;
  const u2 = makeUploader();
  u2.reconcile();
  await u2.flush();
  assert.strictEqual(egressLines().at(-1).outcome, 'ok');
  const st2 = JSON.parse(fs.readFileSync(paths.uploadState, 'utf8'));
  assert.notStrictEqual(st2.uploaded[SID].sha, (st.uploaded[SID] || {}).sha);
});

test('unreachable endpoint records network_error and never throws', async () => {
  config.save({ upload: { endpoint: 'http://127.0.0.1:1/v1/ingest' } });
  const u = makeUploader();
  u.markDirty(SID);
  spoolEvent({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'offline now' }, T0 + 8000);
  spool.drainOnce();
  await u.flush();
  const last = egressLines().at(-1);
  assert.strictEqual(last.kind, 'upload');
  assert.ok(['network_error', 'timeout'].includes(last.outcome), last.outcome);
  config.save({ upload: { endpoint: `http://127.0.0.1:${port}/v1/ingest` } });
});

test('content stripping is unconditional — no config can turn it off', async () => {
  // The old include_content option is gone; a leftover key must be ignored.
  config.save({ upload: { include_content: true } });
  const u = makeUploader();
  u.reconcile();
  await u.flush();
  const doc = received.at(-1).body.sessions.find((d) => d.session_id === SID);
  assert.deepStrictEqual(doc.prompts, []);
  assert.deepStrictEqual(doc.assistant_excerpts, []);
  assert.deepStrictEqual(doc.tools.bash_commands, []);
  assert.ok(doc.counts.prompts >= 2, 'counts survive stripping');
  assert.ok(doc.tools.by_name.Bash >= 1, 'tool evidence survives stripping');
  if (doc.digest) assert.strictEqual(doc.digest.text, undefined);
});

test('heartbeat posts an empty session batch with watcher stats', async () => {
  const u = makeUploader();
  const posts = received.length;
  await u.heartbeat();
  assert.strictEqual(received.length, posts + 1);
  const { body } = received.at(-1);
  assert.deepStrictEqual(body.sessions, []);
  assert.ok(body.watcher.sessions_total >= 1);
  assert.strictEqual(egressLines().at(-1).session_count, 0);
});

test('disabled upload makes zero network calls', async () => {
  config.save({ upload: { enabled: false } });
  const u = makeUploader();
  u.markDirty(SID);
  const posts = received.length;
  u.reconcile();
  await u.flush();
  await u.heartbeat();
  assert.strictEqual(received.length, posts);
  config.save({ upload: { enabled: true } });
});

test('ingest ACK delivers validated normalization tables; junk is dropped, versions gate re-application', async () => {
  const teamConfig = require('../src/team-config');
  let notified = 0;
  const u = createUploader({
    getSchedulerStats: () => SCHED_STATS,
    startedAt: new Date(T0).toISOString(),
    onTeamConfig: () => notified++,
  });

  // Envelope advertises the current (default) table version.
  await u.heartbeat();
  assert.strictEqual(received.at(-1).body.config_version, 0);

  // Server pushes v42 with one bad entry — stored minus the junk, callback fires.
  respondBody = {
    ok: true,
    team_config: { version: 42, aliases: { bun: 'nodejs', 'BAD KEY!': 'x' } },
  };
  await u.heartbeat();
  const stored = JSON.parse(fs.readFileSync(paths.teamConfig, 'utf8'));
  assert.strictEqual(stored.version, 42);
  assert.deepStrictEqual(stored.aliases, { bun: 'nodejs' });
  assert.strictEqual(notified, 1);
  assert.strictEqual(teamConfig.currentVersion(), 42);

  // Same version again → no rewrite, no second notification.
  await u.heartbeat();
  assert.strictEqual(received.at(-1).body.config_version, 42);
  assert.strictEqual(notified, 1);

  // A payload without a version is rejected outright — stored tables survive.
  respondBody = { ok: true, team_config: { aliases: { evil: 'thing' } } };
  await u.heartbeat();
  assert.strictEqual(teamConfig.currentVersion(), 42);
  assert.strictEqual(notified, 1);
  respondBody = null;
});
