'use strict';
// Guardrail probes for the HIGH-severity capability-claim paths: the
// deterministic defenses that keep discussion from becoming hands-on
// experience, plus executable documentation (marked FIXME) of the two known
// holes — substring false-verification and the verified flag dying in project
// aggregation — written to assert CURRENT behavior so they flip when fixed.
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-guard-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { mergeEvidence } = require('../src/classify/classifier');
const { validate } = require('../src/classify/schema');
const { buildDigest, NO_TOOLS_LINE } = require('../src/digest');
const { groupSessions, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS } = require('../src/grouping-core');

const DIGEST_CFG = {
  max_chars: 10000,
  max_prompt_chars: 1500,
  max_prompts: 20,
  max_bash_commands: 40,
  max_files: 60,
  max_excerpts: 5,
  max_excerpt_chars: 800,
};

function mkState(over = {}) {
  return {
    session_id: over.session_id || 'guard-sid',
    created_at: '2026-08-01T10:00:00.000Z',
    last_event_at: '2026-08-01T11:00:00.000Z',
    primary_cwd: 'C:\\proj\\demo',
    git_root: null,
    counts: { prompts: 1, turns: 1, tool_uses: 0, subagent_events: 0, events: 2 },
    prompts: [{ at: '2026-08-01T10:00:00.000Z', text: 'hello', omitted_chars: 0 }],
    tools: {
      by_name: {},
      bash_commands: [],
      files_touched: [],
      extensions: {},
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
    ...over,
  };
}

test('conversation-only session can never yield hands_on, whatever the LLM claims', () => {
  const s = mkState(); // tool_uses: 0
  const merged = mergeEvidence(s, [
    { name: 'Snowflake', evidence: 'hands_on' },
    { name: 'Python', evidence: 'hands_on' },
  ]);
  for (const t of merged) {
    assert.strictEqual(t.evidence, 'discussed', `${t.name} kept hands_on with zero tool usage`);
    assert.strictEqual(t.verified, false);
  }
});

test('exact canonical matching: Java can never be verified by .js files (F2 fixed)', () => {
  const s = mkState({
    counts: { prompts: 1, turns: 1, tool_uses: 5, subagent_events: 0, events: 8 },
    tools: {
      by_name: { Edit: 5 },
      bash_commands: [],
      files_touched: ['C:\\proj\\demo\\index.js'],
      extensions: { '.js': 5 },
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
  });
  const merged = mergeEvidence(s, [
    { name: 'Java', evidence: 'discussed' },
    { name: 'JavaScript', evidence: 'discussed' },
  ]);
  const js = merged.find((t) => t.name === 'JavaScript');
  assert.strictEqual(js.evidence, 'hands_on'); // correct: .js edits corroborate
  assert.strictEqual(js.verified, true);

  // Matching is exact on canonical names — 'java' is NOT 'javascript', so the
  // claim keeps the LLM's own level and is never tool-verified (was the F2
  // substring false-verification hole, fixed 2026-08).
  const java = merged.find((t) => t.name === 'Java');
  assert.strictEqual(java.evidence, 'discussed');
  assert.strictEqual(java.verified, false);
});

test('read-only file access never verifies hands_on (F8 fixed)', () => {
  // Same .js "evidence" as above but produced by Read: it lands in
  // extensions_read, which corroborates nothing.
  const s = mkState({
    counts: { prompts: 1, turns: 1, tool_uses: 5, subagent_events: 0, events: 8 },
    tools: {
      by_name: { Read: 5 },
      bash_commands: [],
      files_touched: ['C:\\proj\\demo\\index.js'],
      extensions: {},
      extensions_read: { '.js': 5 },
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
  });
  const merged = mergeEvidence(s, [{ name: 'JavaScript', evidence: 'discussed' }]);
  assert.strictEqual(merged[0].evidence, 'discussed'); // not promoted
  assert.strictEqual(merged[0].verified, false);
});

test('alias canonicalization verifies Node.js from npm and Postgres from psql', () => {
  const s = mkState({
    counts: { prompts: 1, turns: 1, tool_uses: 2, subagent_events: 0, events: 4 },
    tools: {
      by_name: { Bash: 2 },
      bash_commands: ['npm test', 'psql -c "select 1"'],
      files_touched: [],
      extensions: {},
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
  });
  const merged = mergeEvidence(s, [
    { name: 'Node.js', evidence: 'discussed' },
    { name: 'Postgres', evidence: 'mentioned' },
  ]);
  for (const name of ['Node.js', 'Postgres']) {
    const t = merged.find((x) => x.name === name);
    assert.strictEqual(t.evidence, 'hands_on', `${name} not matched to its command evidence`);
    assert.strictEqual(t.verified, true);
    assert.ok(
      t.basis.some((b) => b.startsWith('tool:')),
      `${name} basis lacks tool source`
    );
  }
});

test('schema coercion of invalid enums always under-claims, never over-claims', () => {
  const v = validate({
    professional_work: true,
    confidence: 0.9,
    work_category: 'consulting', // not an enum value
    work_depth: 'heroic', // not an enum value
    work_stage: 'shipping', // not an enum value
    technologies: [{ name: 'Rust', evidence: 'built' }], // invalid evidence
  });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.work_category, 'unknown'); // abstains
  assert.strictEqual(v.value.work_depth, 'shallow'); // never substantive
  assert.strictEqual(v.value.work_stage, 'unknown');
  assert.strictEqual(v.value.technologies[0].evidence, 'mentioned'); // weakest level
  // Every coercion leaves a trace for _meta.validation_warnings.
  for (const field of ['work_category', 'work_depth', 'work_stage', 'technologies[].evidence']) {
    assert.ok(
      v.errors.some((e) => e.startsWith(field)),
      `no warning recorded for ${field}`
    );
  }
  // Core fields stay fatal.
  assert.strictEqual(validate({ professional_work: 'yes', confidence: 0.5 }).ok, false);
});

test('aggregation preserves verification: project-level hands_on distinguishes tool evidence from claims (F1 fixed)', () => {
  const verifiedState = mkState({
    session_id: 'sid-verified',
    primary_cwd: 'C:\\proj\\one',
    classification: {
      work_category: 'client_work',
      industry: [],
      tasks: [],
      project_hint: 'one',
      technologies: [
        {
          name: 'React',
          evidence: 'hands_on',
          basis: ['semantic', 'tool:.tsx_files'],
          verified: true,
        },
      ],
    },
  });
  const unverifiedState = mkState({
    session_id: 'sid-unverified',
    primary_cwd: 'C:\\proj\\two',
    classification: {
      work_category: 'client_work',
      industry: [],
      tasks: [],
      project_hint: 'two',
      technologies: [{ name: 'React', evidence: 'hands_on', basis: ['semantic'], verified: false }],
    },
  });
  const { projects } = groupSessions(
    [verifiedState, unverifiedState],
    EMPTY_CORRECTIONS,
    WINDOWS_PATH_OPTS
  );
  assert.strictEqual(projects.length, 2);
  const byCwd = (cwd) => projects.find((p) => p.key.value.includes(cwd));
  const verifiedAgg = byCwd('one').aggregate.technologies.find((t) => t.canonical === 'react');
  const unverifiedAgg = byCwd('two').aggregate.technologies.find((t) => t.canonical === 'react');
  // Both are hands_on, but the verified flag now survives aggregation (F1):
  // a tool-corroborated React project is distinguishable from a
  // classifier-claim-only one, and the UI renders the latter dashed.
  assert.strictEqual(verifiedAgg.max_evidence, 'hands_on');
  assert.strictEqual(unverifiedAgg.max_evidence, 'hands_on');
  assert.strictEqual(verifiedAgg.verified_sessions, 1);
  assert.strictEqual(verifiedAgg.verified_max_evidence, 'hands_on');
  assert.strictEqual(unverifiedAgg.verified_sessions, 0);
  assert.strictEqual(unverifiedAgg.verified_max_evidence, null);
});

test('digest keeps TOOL ACTIVITY through shrink levels; evidence merge never depends on the digest', () => {
  const big = mkState({
    counts: { prompts: 30, turns: 30, tool_uses: 400, subagent_events: 0, events: 500 },
    prompts: Array.from({ length: 30 }, (_, i) => ({
      at: '2026-08-01T10:00:00.000Z',
      text: `prompt ${i} ` + 'x'.repeat(1200),
      omitted_chars: 0,
    })),
    tools: {
      by_name: { Bash: 200, Edit: 200 },
      bash_commands: Array.from(
        { length: 200 },
        (_, i) => `npm run step-${i} -- --flag value-${i}`
      ),
      files_touched: Array.from({ length: 100 }, (_, i) => `C:\\proj\\demo\\src\\file-${i}.ts`),
      extensions: { '.ts': 200 },
      mcp_servers: [],
      web: { fetch_domains: [], search_queries: [] },
      dependencies_observed: [],
    },
  });

  const digest = buildDigest(big, DIGEST_CFG);
  assert.ok(digest.length <= DIGEST_CFG.max_chars);
  assert.ok(digest.includes('TOOL ACTIVITY'));
  assert.ok(digest.includes('- tool usage counts:'));
  assert.ok(!digest.includes(NO_TOOLS_LINE));

  // Pathological budget: the hard floor slices the tail, and TOOL ACTIVITY is
  // the last section — the LLM can lose sight of tool usage entirely...
  const tiny = buildDigest(big, { ...DIGEST_CFG, max_chars: 400 });
  assert.ok(tiny.length <= 400);
  assert.ok(!tiny.includes('tool usage counts'));
  // ...but hands_on verification comes from state, not the digest, so the
  // deterministic merge still corroborates regardless of truncation.
  const merged = mergeEvidence(big, [{ name: 'TypeScript', evidence: 'discussed' }]);
  assert.strictEqual(merged[0].evidence, 'hands_on');
  assert.strictEqual(merged[0].verified, true);
});
