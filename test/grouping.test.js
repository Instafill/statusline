'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-grp-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { ensureDirs, sessionFile } = require('../src/paths');
const { writeJsonAtomic } = require('../src/util/jsonfile');
const grouping = require('../src/grouping');

ensureDirs();

function makeSession(sid, over = {}) {
  const state = {
    v: 1,
    session_id: sid,
    created_at: '2026-08-10T10:00:00Z',
    last_event_at: '2026-08-10T11:00:00Z',
    cwds: ['c:\\repo\\app'],
    primary_cwd: 'c:\\repo\\app',
    git_root: 'C:\\repo',
    transcript_path: null,
    counts: { prompts: 2, turns: 2, tool_uses: 3, subagent_events: 0, events: 9 },
    prompts: [],
    tools: { by_name: {}, bash_commands: [], files_touched: [], extensions: {}, mcp_servers: [], web: { fetch_domains: [], search_queries: [] }, dependencies_observed: [] },
    classification_state: 'classified',
    classified_at: '2026-08-10T11:05:00Z',
    turns_at_classification: 2,
    classification: {
      schema_version: 1,
      professional_work: true,
      work_category: 'client_work',
      work_type: 'software development',
      industry: ['saas'],
      business_function: ['engineering'],
      tasks: ['data migration'],
      technologies: [{ name: 'TypeScript', evidence: 'hands_on', basis: ['semantic'] }],
      artifacts: [],
      work_stage: 'implementation',
      work_depth: 'substantive',
      project_hint: 'hubspot revops migration',
      continuation: false,
      confidence: 0.8,
      rationale: 'test',
    },
    ...over,
  };
  writeJsonAtomic(sessionFile(sid), state);
  return state;
}

test('sessions in the same git root group into one project', () => {
  makeSession('s1');
  makeSession('s2', { created_at: '2026-08-11T10:00:00Z', last_event_at: '2026-08-11T11:00:00Z' });
  const out = grouping.recompute();
  assert.strictEqual(out.projects.length, 1);
  const p = out.projects[0];
  assert.strictEqual(p.key.kind, 'git_root');
  assert.strictEqual(p.session_ids.length, 2);
  assert.strictEqual(p.name, 'repo');
  // Aggregation keys by canonical name; the display name rides along.
  const ts = p.aggregate.technologies.find((t) => t.canonical === 'typescript');
  assert.strictEqual(ts.max_evidence, 'hands_on');
  assert.strictEqual(ts.name, 'TypeScript');
  // Recent-work lines carry the task text with its session date.
  assert.ok(p.aggregate.tasks_recent.some((l) => l.text === 'data migration' && l.at));
});

test('similar project in another directory gets a merge suggestion', () => {
  makeSession('s3', {
    primary_cwd: 'c:\\other\\dir',
    git_root: null,
    cwds: ['c:\\other\\dir'],
    created_at: '2026-08-11T12:00:00Z',
    last_event_at: '2026-08-11T13:00:00Z',
    classification: {
      ...makeSession('tmp-discard').classification,
      project_hint: 'hubspot revops migration phase two',
      continuation: true,
    },
  });
  // remove the throwaway
  fs.unlinkSync(sessionFile('tmp-discard'));
  const out = grouping.recompute();
  assert.strictEqual(out.projects.length, 2);
  const suggestions = out.projects.flatMap((p) => p.suggested_merges);
  assert.ok(suggestions.length >= 1, 'expected a merge suggestion');
  assert.ok(suggestions[0].reasons.includes('hint_overlap'));
});

test('corrections survive recompute: rename, manual move, ignore', () => {
  const out1 = grouping.recompute();
  const mainId = out1.projects.find((p) => p.key.kind === 'git_root').id;
  grouping.renameProject(mainId, 'HubSpot RevOps');
  grouping.setSessionProject('s3', mainId);
  makeSession('s4', { classification: null, classification_state: 'unclassified' });
  grouping.setSessionLabel('s4', 'ignore');
  const out2 = grouping.recompute();
  const main = out2.projects.find((p) => p.id === mainId);
  assert.strictEqual(main.name, 'HubSpot RevOps');
  assert.ok(main.session_ids.includes('s3'), 's3 not moved into main project');
  assert.ok(!out2.projects.some((p) => p.session_ids.includes('s4')), 'ignored session still grouped');
});

test('field overrides apply to aggregation', () => {
  grouping.setSessionOverrides('s1', { industry: ['fintech'] });
  const out = grouping.recompute();
  const main = out.projects.find((p) => p.name === 'HubSpot RevOps');
  assert.ok(main.aggregate.industries.includes('fintech'));
});

test('dismissed merge suggestions stay dismissed', () => {
  grouping.setSessionProject('s3', null); // back to its own project
  const out = grouping.recompute();
  const withSugg = out.projects.find((p) => p.suggested_merges.length > 0);
  assert.ok(withSugg, 'suggestion should reappear after unmove');
  const other = withSugg.suggested_merges[0].project_id;
  grouping.dismissMerge(withSugg.id, other);
  const out2 = grouping.recompute();
  assert.ok(out2.projects.every((p) => p.suggested_merges.length === 0), 'dismissed pair suggested again');
});

// ---- shared core (cloud-side path handling) --------------------------------

const core = require('../src/grouping-core');

test('slash path opts group Windows and mac clones of the same repo together', () => {
  const win = makeSession('x-win', { git_root: 'C:\\Users\\sampleuser\\work\\Acme-App', primary_cwd: 'c:\\users\\sampleuser\\work\\acme-app' });
  const mac = makeSession('x-mac', { git_root: '/Users/jo/work/acme-app', primary_cwd: '/Users/jo/work/acme-app' });
  fs.unlinkSync(sessionFile('x-win'));
  fs.unlinkSync(sessionFile('x-mac'));
  // Distinct machines, distinct roots — path folding alone must NOT merge them,
  // but a cwd under either root must absorb into its own git root by prefix.
  const winChild = { ...win, session_id: 'x-win-child', git_root: null, primary_cwd: 'C:\\Users\\sampleuser\\work\\Acme-App\\packages\\ui' };
  const grouped = core.groupSessions([win, mac, winChild], core.EMPTY_CORRECTIONS, core.SLASH_PATH_OPTS);
  const byKind = grouped.projects.filter((p) => p.key.kind === 'git_root');
  assert.strictEqual(byKind.length, 2, 'two distinct git roots stay distinct');
  const winProj = grouped.projects.find((p) => p.key.value === 'c:/users/sampleuser/work/acme-app');
  assert.ok(winProj, 'windows root folded to forward slashes');
  assert.ok(winProj.session_ids.includes('x-win-child'), 'child cwd absorbed into git root via / prefix');
  assert.strictEqual(winProj.name, 'acme-app', 'cross-platform basename');
  const macProj = grouped.projects.find((p) => p.key.value === '/users/jo/work/acme-app');
  assert.ok(macProj, 'posix root folded');
  assert.strictEqual(macProj.name, 'acme-app');
});

test('local Windows path opts produce byte-identical project ids (stability guard)', () => {
  // Hash pinned to the pre-extraction implementation: sha1('git_root|c:\repo')
  // — if this changes, every corrections.json project entry orphans.
  assert.strictEqual(core.projectIdOf('git_root', 'c:\\repo'), 'prj_' + require('crypto').createHash('sha1').update('git_root|c:\\repo').digest('hex').slice(0, 10));
  const out = grouping.recompute();
  const main = out.projects.find((p) => p.key.kind === 'git_root' && p.key.value === 'c:\\repo');
  assert.ok(main, 'windows normKey unchanged: value stays backslash-lowercase');
});
