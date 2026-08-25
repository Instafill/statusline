'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-pipe-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { ensureDirs } = require('../src/paths');
const sessions = require('../src/watcher/sessions');
const spool = require('../src/watcher/spool');
const { buildDigest, NO_TOOLS_LINE } = require('../src/digest');
const { maskSecrets } = require('../src/util/secrets');
const config = require('../src/config');

ensureDirs();
const SPOOL_NEW = path.join(TESTHOME, 'spool', 'new');

let seq = 0;
function spoolEvent(payload, tsMs) {
  const name = `${tsMs}-1234-ev${String(seq++).padStart(4, '0')}.json`;
  fs.writeFileSync(path.join(SPOOL_NEW, name), JSON.stringify(payload));
  return name;
}

const SID = 'aaaa-bbbb-cccc';
const BASE = {
  session_id: SID,
  transcript_path: 'C:\\nope\\t.jsonl',
  cwd: 'C:\\work\\statusline',
  permission_mode: 'default',
};
const T0 = 1755000000000;

function seedToolHeavySession() {
  spoolEvent({ ...BASE, hook_event_name: 'SessionStart', source: 'startup' }, T0);
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Fix the failing HubSpot sync job and add retries',
    },
    T0 + 1000
  );
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm install axios && npm test' },
    },
    T0 + 2000
  );
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: {
        file_path: 'C:\\proj\\src\\sync.ts',
        old_string: 'x'.repeat(900),
        new_string: 'y'.repeat(900),
      },
    },
    T0 + 3000
  );
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__hubspot__update_contact',
      tool_input: { id: 5 },
    },
    T0 + 4000
  );
  spoolEvent(
    {
      ...BASE,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'curl -H "Authorization: Bearer abc123secrettoken456" https://api.hubspot.com',
      },
    },
    T0 + 5000
  );
  spoolEvent({ ...BASE, hook_event_name: 'Stop', stop_hook_active: false }, T0 + 6000);
  spoolEvent({ ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'now deploy it' }, T0 + 7000);
  spoolEvent({ ...BASE, hook_event_name: 'Stop', stop_hook_active: false }, T0 + 8000);
  spoolEvent({ ...BASE, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, T0 + 9000);
}

test('spool drain + fold derives correct session state', () => {
  seedToolHeavySession();
  spoolEvent({ nonsense: true }, T0 + 9500); // no session_id → quarantine
  const res = spool.drainOnce();
  assert.strictEqual(res.ingested, 10);
  assert.strictEqual(res.quarantined, 1);
  assert.deepStrictEqual(res.sessions, [SID]);
  assert.strictEqual(fs.readdirSync(SPOOL_NEW).length, 0);
  assert.strictEqual(fs.readdirSync(path.join(TESTHOME, 'spool', 'quarantine')).length, 1);

  const s = sessions.getSession(SID);
  assert.strictEqual(s.counts.prompts, 2);
  assert.strictEqual(s.counts.turns, 2);
  assert.strictEqual(s.counts.tool_uses, 4);
  assert.strictEqual(s.end_reason, 'prompt_input_exit');
  assert.deepStrictEqual(s.sources, ['startup']);
  assert.strictEqual(s.primary_cwd, 'C:\\work\\statusline');
  assert.strictEqual(s.tools.by_name.Bash, 2);
  assert.deepStrictEqual(s.tools.mcp_servers, ['hubspot']);
  assert.deepStrictEqual(s.tools.files_touched, ['C:\\proj\\src\\sync.ts']);
  assert.strictEqual(s.tools.extensions['.ts'], 1);
  assert.ok(s.tools.dependencies_observed.includes('axios'));
  // Secret masked in captured bash command.
  const joined = s.tools.bash_commands.join('\n');
  assert.ok(!joined.includes('abc123secrettoken456'), 'bearer token leaked into state');
  assert.ok(joined.includes('Bearer ***'));
  // Edit strings pruned (>500 chars) — nothing near 900 chars in the log.
  const rawLog = fs.readFileSync(path.join(TESTHOME, 'sessions', `${SID}.events.jsonl`), 'utf8');
  assert.ok(!rawLog.includes('y'.repeat(600)), 'large new_string not pruned');
});

test('re-ingesting duplicate events does not double-count (fold dedupe)', () => {
  seq = 0; // same filenames as the first seeding → same event ids
  seedToolHeavySession();
  spool.drainOnce();
  const s = sessions.getSession(SID);
  assert.strictEqual(s.counts.prompts, 2);
  assert.strictEqual(s.counts.turns, 2);
  assert.strictEqual(s.counts.tool_uses, 4);
});

test('digest renders tool activity and metadata', () => {
  const s = sessions.getSession(SID);
  const d = buildDigest(s, config.load().digest);
  assert.ok(d.includes('SESSION METADATA'));
  assert.ok(d.includes('HubSpot sync job'));
  assert.ok(d.includes('MCP servers used: hubspot'));
  assert.ok(d.includes('npm install axios'));
  assert.ok(!d.includes('abc123secrettoken456'));
  assert.ok(d.includes('(transcript unavailable)'));
});

test('pure-conversation session digest says conversation only', () => {
  const sid2 = 'pure-convo-1';
  const base2 = { ...BASE, session_id: sid2, cwd: 'C:\\somewhere\\else' };
  spoolEvent(
    {
      ...base2,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Analyze why this insurance claims operation is losing money',
    },
    T0 + 20000
  );
  spoolEvent({ ...base2, hook_event_name: 'Stop', stop_hook_active: false }, T0 + 21000);
  spool.drainOnce();
  const s = sessions.getSession(sid2);
  assert.strictEqual(s.counts.tool_uses, 0);
  const d = buildDigest(s, config.load().digest);
  assert.ok(d.includes(NO_TOOLS_LINE));
});

test('digest shrinks under budget for oversized sessions', () => {
  const sid3 = 'big-session';
  const base3 = { ...BASE, session_id: sid3 };
  let ts = T0 + 30000;
  for (let i = 0; i < 60; i++) {
    spoolEvent(
      {
        ...base3,
        hook_event_name: 'UserPromptSubmit',
        prompt: `prompt ${i}: ` + 'lorem ipsum '.repeat(120),
      },
      ts++
    );
    spoolEvent({ ...base3, hook_event_name: 'Stop' }, ts++);
  }
  spool.drainOnce();
  const s = sessions.getSession(sid3);
  const cfg = config.load().digest;
  const d = buildDigest(s, cfg);
  assert.ok(d.length <= cfg.max_chars, `digest ${d.length} > ${cfg.max_chars}`);
  assert.ok(d.includes('prompts') && d.includes('omitted'));
});

test('system-generated pseudo-prompts do not count as prompts or turns', () => {
  const sid4 = 'sys-prompt-1';
  const base4 = { ...BASE, session_id: sid4 };
  let ts = T0 + 40000;
  spoolEvent({ ...base4, hook_event_name: 'UserPromptSubmit', prompt: 'real user question' }, ts++);
  spoolEvent({ ...base4, hook_event_name: 'Stop' }, ts++);
  spoolEvent(
    {
      ...base4,
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification> <task-id>abc</task-id> stopped',
    },
    ts++
  );
  spoolEvent({ ...base4, hook_event_name: 'Stop' }, ts++);
  spoolEvent(
    {
      ...base4,
      hook_event_name: 'UserPromptSubmit',
      prompt: '<command-name>/compact</command-name> output',
    },
    ts
  );
  spool.drainOnce();
  const s = sessions.getSession(sid4);
  assert.strictEqual(s.counts.prompts, 1);
  assert.strictEqual(s.counts.turns, 1);
  assert.strictEqual(s.prompts[0].text, 'real user question');
});

test('mergeEvidence marks tool-corroborated techs verified, LLM-only claims unverified', () => {
  const { mergeEvidence } = require('../src/classify/classifier');
  const s = sessions.getSession(SID); // tool-heavy session: .ts edits, npm, mcp hubspot
  const merged = mergeEvidence(s, [
    { name: 'TypeScript', evidence: 'discussed' },
    { name: 'Kafka', evidence: 'hands_on' },
  ]);
  const ts = merged.find((t) => t.name === 'TypeScript');
  assert.strictEqual(ts.evidence, 'hands_on');
  assert.strictEqual(ts.verified, true);
  const kafka = merged.find((t) => t.name === 'Kafka');
  assert.strictEqual(kafka.evidence, 'hands_on'); // level kept — session has tools
  assert.strictEqual(kafka.verified, false); // but flagged as classifier claim only
  const hubspot = merged.find((t) => t.name === 'hubspot');
  assert.strictEqual(hubspot.verified, true);
});

test('zero-turn sessions get depth and confidence capped; sessions with turns do not', () => {
  const { applyZeroTurnCaps } = require('../src/classify/classifier');
  const value = { work_depth: 'substantive', confidence: 0.88 };
  const capped = applyZeroTurnCaps({ counts: { turns: 0 } }, value);
  assert.deepStrictEqual(capped.sort(), ['confidence', 'work_depth']);
  assert.strictEqual(value.work_depth, 'shallow');
  assert.strictEqual(value.confidence, 0.5);

  // Already-modest values pass through untouched (no cap entries).
  const modest = { work_depth: 'trivial', confidence: 0.3 };
  assert.deepStrictEqual(applyZeroTurnCaps({ counts: { turns: 0 } }, modest), []);
  assert.strictEqual(modest.work_depth, 'trivial');
  assert.strictEqual(modest.confidence, 0.3);

  // A session with completed turns is never capped.
  const worked = { work_depth: 'substantive', confidence: 0.9 };
  assert.deepStrictEqual(applyZeroTurnCaps({ counts: { turns: 3 } }, worked), []);
  assert.strictEqual(worked.work_depth, 'substantive');
});

test('continuation sessions inherit a recent project classification; divergent evidence does not', () => {
  const { tryInherit } = require('../src/classify/inherit');
  const cwd = 'C:\\proj\\inherit-demo';
  let ts = T0 + 50000;

  // Donor: a real LLM-classified session in the project.
  const donorSid = 'inherit-donor';
  const donorBase = { ...BASE, session_id: donorSid, cwd };
  spoolEvent({ ...donorBase, hook_event_name: 'SessionStart', source: 'startup' }, ts++);
  spoolEvent(
    { ...donorBase, hook_event_name: 'UserPromptSubmit', prompt: 'build the hubspot sync' },
    ts++
  );
  spoolEvent({ ...donorBase, hook_event_name: 'Stop' }, ts++);
  spool.drainOnce();
  sessions.updateSession(donorSid, {
    classification_state: 'classified',
    classified_at: new Date().toISOString(),
    classification: {
      schema_version: 1,
      professional_work: true,
      work_category: 'client_work',
      work_type: 'crm integration development',
      industry: ['sales'],
      business_function: ['revenue operations'],
      tasks: ['built sync'],
      artifacts: [],
      work_stage: 'implementation',
      work_depth: 'substantive',
      project_hint: 'hubspot sync',
      continuation: false,
      confidence: 0.9,
      rationale: 'donor',
      technologies: [
        { name: 'TypeScript', evidence: 'hands_on', basis: ['semantic'], verified: true },
        { name: 'HubSpot', evidence: 'discussed', basis: ['semantic'], verified: false },
      ],
      _meta: { classifier: 'claude-cli', model: 'haiku' },
    },
  });

  // Continuation: resumed session, same project, no tools → inherits.
  const contSid = 'inherit-cont';
  const contBase = { ...BASE, session_id: contSid, cwd };
  spoolEvent({ ...contBase, hook_event_name: 'SessionStart', source: 'resume' }, ts++);
  spoolEvent(
    { ...contBase, hook_event_name: 'UserPromptSubmit', prompt: 'continue where we left off' },
    ts++
  );
  spoolEvent({ ...contBase, hook_event_name: 'Stop' }, ts++);
  spool.drainOnce();
  const inherited = tryInherit(sessions.getSession(contSid), config.load(), 'idle');
  assert.ok(inherited, 'expected inheritance');
  assert.strictEqual(inherited._meta.classifier, 'inherited');
  assert.strictEqual(inherited._meta.inherited_from, donorSid);
  assert.strictEqual(inherited.work_category, 'client_work');
  assert.strictEqual(inherited.continuation, true);
  assert.ok(inherited.confidence < 0.9, 'confidence must be reduced');
  // Zero-tool continuation: donor hands_on demoted to discussed for THIS session.
  const tsTech = inherited.technologies.find((t) => t.name === 'TypeScript');
  assert.strictEqual(tsTech.evidence, 'discussed');

  // Divergent evidence (python files, foreign to the donor's techs) → no inheritance.
  const divSid = 'inherit-diverged';
  const divBase = { ...BASE, session_id: divSid, cwd };
  spoolEvent({ ...divBase, hook_event_name: 'SessionStart', source: 'resume' }, ts++);
  spoolEvent(
    { ...divBase, hook_event_name: 'UserPromptSubmit', prompt: 'now analyze the data' },
    ts++
  );
  spoolEvent(
    {
      ...divBase,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'C:\\proj\\analysis.py' },
    },
    ts++
  );
  spoolEvent({ ...divBase, hook_event_name: 'Stop' }, ts++);
  spool.drainOnce();
  assert.strictEqual(tryInherit(sessions.getSession(divSid), config.load(), 'idle'), null);

  // Fresh (non-continuation) session never inherits.
  const freshSid = 'inherit-fresh';
  const freshBase = { ...BASE, session_id: freshSid, cwd };
  spoolEvent({ ...freshBase, hook_event_name: 'SessionStart', source: 'startup' }, ts++);
  spoolEvent({ ...freshBase, hook_event_name: 'UserPromptSubmit', prompt: 'new topic' }, ts++);
  spoolEvent({ ...freshBase, hook_event_name: 'Stop' }, ts);
  spool.drainOnce();
  assert.strictEqual(tryInherit(sessions.getSession(freshSid), config.load(), 'idle'), null);
});

test('heuristic fallback derives category from project history and techs from tool evidence', () => {
  const { heuristicClassification } = require('../src/classify/heuristic');
  // The diverged session from the inherit test: sibling donor voted client_work.
  const s = sessions.getSession('inherit-diverged');
  const h = heuristicClassification(s, { trigger: 'idle', reason: 'auth_error' });
  assert.strictEqual(h._meta.classifier, 'heuristic');
  assert.strictEqual(h._meta.fallback_reason, 'auth_error');
  assert.strictEqual(h.work_category, 'client_work'); // majority vote from siblings
  assert.strictEqual(h.work_type, 'crm integration development'); // most recent classified sibling
  assert.strictEqual(h.confidence, 0.25);
  assert.strictEqual(h.work_depth, 'shallow'); // 1 turn, 1 tool call
  const py = h.technologies.find((t) => t.name === 'Python');
  assert.ok(py, 'python from .py tool evidence');
  assert.strictEqual(py.evidence, 'hands_on');
  assert.strictEqual(py.verified, true);
});

test('host pid is folded from hook payloads and drives liveness', () => {
  const { isAlive } = require('../src/util/proc');
  const sid5 = 'host-pid-1';
  const base5 = { ...BASE, session_id: sid5 };
  let ts = T0 + 60000;
  spoolEvent(
    {
      ...base5,
      hook_event_name: 'SessionStart',
      source: 'startup',
      _statusline: { claude_pid: process.pid },
    },
    ts++
  );
  spoolEvent({ ...base5, hook_event_name: 'UserPromptSubmit', prompt: 'hello' }, ts);
  spool.drainOnce();
  const s = sessions.getSession(sid5);
  assert.strictEqual(s.host_pid, process.pid);
  assert.strictEqual(isAlive(s.host_pid), true); // this test process is alive

  // A pid that cannot exist reads as not alive; missing/invalid reads unknown.
  assert.strictEqual(isAlive(0x7ffffffe), false);
  assert.strictEqual(isAlive(null), null);
  assert.strictEqual(isAlive(undefined), null);

  // Sessions observed without the field keep host_pid null (unknown, not dead).
  assert.strictEqual(sessions.getSession(SID).host_pid, null);
});

test('maskSecrets covers common credential shapes', () => {
  assert.strictEqual(maskSecrets('key sk-ant-abc123def456ghi789'), 'key ***');
  assert.ok(maskSecrets('password=hunter2secret').includes('password=***'));
  assert.ok(maskSecrets('https://user:p4ssw0rd@host.com/x').includes('user:***@host.com'));
  assert.strictEqual(maskSecrets('plain text stays'), 'plain text stays');
});

test('technologies re-derive on every fold: legacy adoption, corroboration, retroactive table updates', () => {
  const { paths } = require('../src/paths');
  // A legacy classification (no technologies_raw, as all pre-2026-08 states).
  sessions.updateSession(SID, {
    classification: {
      work_category: 'client_work',
      technologies: [
        { name: 'TypeScript', evidence: 'discussed', basis: ['semantic'], verified: false },
        { name: 'Kafka', evidence: 'hands_on', basis: ['semantic'], verified: false },
      ],
    },
    classification_state: 'classified',
  });
  let cls = sessions.foldSession(SID).classification;
  assert.ok(Array.isArray(cls.technologies_raw), 'legacy technologies adopted as raw');
  const ts = cls.technologies.find((t) => t.canonical === 'typescript');
  assert.strictEqual(ts.evidence, 'hands_on'); // re-corroborated by the .ts edit in this session
  assert.strictEqual(ts.verified, true);
  const kafka = cls.technologies.find((t) => t.canonical === 'kafka');
  assert.strictEqual(kafka.verified, false); // claim only — no kafka tool evidence

  // A server table update rewires matching and history corrects itself on the
  // next fold — zero classifier calls. (Absurd mapping on purpose: prove the
  // mechanism, not the vocabulary.)
  fs.writeFileSync(paths.teamConfig, JSON.stringify({ version: 5, ext_tech: { '.ts': 'kafka' } }));
  cls = sessions.foldSession(SID).classification;
  const kafka2 = cls.technologies.find((t) => t.canonical === 'kafka');
  assert.strictEqual(kafka2.verified, true, 'table update applied retroactively at fold time');
  assert.ok(kafka2.basis.some((b) => b === 'tool:.ts_files'));
});
