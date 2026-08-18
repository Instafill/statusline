'use strict';
// Probes of project-grouping behavior (Task 3 eval → Task 4 fixes): catch-all
// cwds become per-session singletons, linked worktrees fold into their parent
// repo when git_main_root is captured, and the merge-suggestion score under
// stopword hints, temporal decay, the continuation window, and origin match.
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-groupsim-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { groupSessions, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS } = require('../src/grouping-core');

let n = 0;
function mkState({ cwd, gitRoot = null, mainRoot = null, origin = null, created, last, cls = null }) {
  return {
    session_id: `sim-${n++}`,
    created_at: created,
    last_event_at: last || created,
    primary_cwd: cwd,
    git_root: gitRoot,
    git_main_root: mainRoot,
    git_origin: origin,
    counts: { prompts: 1, turns: 1, tool_uses: 0, subagent_events: 0, events: 2 },
    classification: cls,
  };
}

function cls(hint, techs, { category = 'internal_work', industry = [], continuation = false } = {}) {
  return {
    work_category: category,
    industry,
    tasks: [],
    project_hint: hint,
    continuation,
    technologies: techs.map(([name, evidence]) => ({ name, evidence, basis: ['semantic'], verified: false })),
  };
}

test('catch-all cwd sessions become flagged singletons, never one mega-project', () => {
  const invoicing = mkState({
    cwd: 'C:\\Users\\sampleuser',
    created: '2026-08-01T10:00:00.000Z',
    cls: cls('acme invoicing', [['QuickBooks', 'discussed']], { category: 'client_work', industry: ['accounting'] }),
  });
  const holiday = mkState({
    cwd: 'C:\\Users\\sampleuser',
    created: '2026-08-05T10:00:00.000Z',
    cls: cls('holiday photos', [['Python', 'hands_on']], { category: 'personal' }),
  });
  const { projects } = groupSessions([invoicing, holiday], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(projects.length, 2, 'each catch-all session stands alone');
  for (const p of projects) {
    assert.strictEqual(p.singleton, true);
    assert.strictEqual(p.key.kind, 'session');
    assert.deepStrictEqual(Object.values(p.membership), ['singleton']);
  }
  // Evidence stays pure: the personal Python session shares nothing with the
  // client QuickBooks one; names fall back to the classifier hints.
  const names = projects.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['acme invoicing', 'holiday photos']);
  // Stable ids: the singleton key is the session id, so recomputes agree.
  const again = groupSessions([invoicing, holiday], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.deepStrictEqual(again.projects.map((p) => p.id).sort(), projects.map((p) => p.id).sort());
});

test('cwd inside a known git root is absorbed into the repo project', () => {
  const repo = mkState({
    cwd: 'C:\\work\\shop',
    gitRoot: 'C:\\work\\shop',
    created: '2026-08-01T10:00:00.000Z',
    cls: cls('shop backend', [['Node.js', 'hands_on']]),
  });
  const sub = mkState({
    cwd: 'C:\\work\\shop\\packages\\api',
    created: '2026-08-02T10:00:00.000Z',
    cls: cls('shop api', [['Node.js', 'hands_on']]),
  });
  const { projects } = groupSessions([repo, sub], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].session_ids.length, 2);
});

test('pre-capture worktree sessions (no git_main_root) still split, but strong overlap suggests the merge', () => {
  const main = mkState({
    cwd: 'C:\\work\\statusline',
    gitRoot: 'C:\\work\\statusline',
    created: '2026-08-14T10:00:00.000Z',
    last: '2026-08-14T12:00:00.000Z',
    cls: cls('statusline machines registry', [['MongoDB', 'hands_on']]),
  });
  const worktree = mkState({
    cwd: 'C:\\work\\statusline-wt-mongo',
    gitRoot: 'C:\\work\\statusline-wt-mongo', // linked worktree = different root
    created: '2026-08-14T13:00:00.000Z',
    last: '2026-08-14T15:00:00.000Z',
    cls: cls('statusline machines registry', [['MongoDB', 'hands_on']], { continuation: true }),
  });
  const { projects } = groupSessions([main, worktree], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(projects.length, 2); // degraded mode: field absent on old states
  const suggestions = projects.flatMap((p) => p.suggested_merges);
  assert.strictEqual(suggestions.length, 1, 'overlapping worktree pair not suggested for merge');
  assert.ok(suggestions[0].score >= 0.6);
});

test('a linked worktree with git_main_root folds into the parent repo project — parent id unchanged', () => {
  const main = mkState({
    cwd: 'C:\\work\\statusline',
    gitRoot: 'C:\\work\\statusline',
    created: '2026-08-14T10:00:00.000Z',
    cls: cls('statusline machines registry', [['MongoDB', 'hands_on']]),
  });
  const worktree = mkState({
    cwd: 'C:\\work\\statusline\\wt\\mongo-machines',
    gitRoot: 'C:\\work\\statusline\\wt\\mongo-machines',
    mainRoot: 'C:\\work\\statusline',
    created: '2026-08-14T13:00:00.000Z',
    cls: cls('statusline machines registry', [['MongoDB', 'hands_on']]),
  });
  const soloId = groupSessions([main], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS).projects[0].id;
  const { projects } = groupSessions([main, worktree], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(projects.length, 1, 'worktree folded into the parent');
  assert.strictEqual(projects[0].id, soloId, 'parent project id must not change');
  assert.strictEqual(projects[0].membership[main.session_id], 'git_root');
  assert.strictEqual(projects[0].membership[worktree.session_id], 'worktree');
});

test('same origin on different checkout paths crosses the suggestion threshold on its own', () => {
  const a = mkState({
    cwd: 'C:\\work\\acme',
    gitRoot: 'C:\\work\\acme',
    origin: 'https://github.com/acme/widgets.git',
    created: '2026-06-01T10:00:00.000Z',
    cls: cls('acme backend', [['Node.js', 'hands_on']]),
  });
  const b = mkState({
    cwd: 'D:\\repos\\acme-clone',
    gitRoot: 'D:\\repos\\acme-clone',
    origin: 'git@github.com:acme/widgets', // scp-style, no .git — same repo
    created: '2026-08-01T10:00:00.000Z', // far apart in time: origin must carry alone
    cls: cls('completely different hint', [['Python', 'discussed']]),
  });
  const { projects } = groupSessions([a, b], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  const suggestions = projects.flatMap((p) => p.suggested_merges);
  assert.strictEqual(suggestions.length, 1, 'same-origin pair must be suggested');
  assert.ok(suggestions[0].reasons.includes('same_origin'));
});

test('an engagement claims projects by raw path and origin keys under BOTH normalizations', () => {
  const core = require('../src/grouping-core');
  const corrections = {
    ...EMPTY_CORRECTIONS,
    engagements: {
      eng_abc123: {
        name: 'Acme Portal',
        kind: 'client',
        keys: [
          { kind: 'git_root', value: 'C:\\work\\acme' }, // raw, un-normalized
          { kind: 'origin', value: 'https://github.com/acme/widgets.git' },
        ],
      },
    },
  };
  const byPath = mkState({
    cwd: 'C:\\work\\acme',
    gitRoot: 'C:\\work\\acme',
    created: '2026-08-01T10:00:00.000Z',
    cls: cls('acme backend', [['Node.js', 'hands_on']]),
  });
  const byOrigin = mkState({
    cwd: '/users/jo/dev/acme',
    gitRoot: '/users/jo/dev/acme',
    origin: 'git@github.com:acme/widgets.git',
    created: '2026-08-02T10:00:00.000Z',
    cls: cls('acme frontend', [['React', 'hands_on']]),
  });
  for (const opts of [WINDOWS_PATH_OPTS, core.SLASH_PATH_OPTS]) {
    const { projects } = groupSessions([byPath, byOrigin], corrections, opts);
    assert.strictEqual(projects.length, 1, 'both routes fold into the engagement');
    const p = projects[0];
    assert.strictEqual(p.id, 'eng_abc123');
    assert.strictEqual(p.key.kind, 'engagement');
    assert.strictEqual(p.engagement_id, 'eng_abc123');
    assert.strictEqual(p.engagement_kind, 'client');
    assert.strictEqual(p.name, 'Acme Portal', 'registry name outranks basename');
    assert.strictEqual(p.session_ids.length, 2);
  }
});

test('technology aggregate carries the evidence trace with exact counts and a capped row list', () => {
  const states = [];
  for (let i = 0; i < 30; i++) {
    states.push(
      mkState({
        cwd: 'C:\\work\\big',
        gitRoot: 'C:\\work\\big',
        created: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
        cls: cls('big project', [['Kafka', 'discussed']]),
      })
    );
  }
  const { projects } = groupSessions(states, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  const kafka = projects[0].aggregate.technologies.find((t) => t.canonical === 'kafka');
  assert.strictEqual(kafka.sessions, 30, 'counts stay exact');
  assert.strictEqual(kafka.evidence.length, 25, 'trace capped at 25 rows');
  assert.ok(kafka.evidence.every((r) => r.session_id && r.evidence === 'discussed' && r.category === 'internal_work'));
  assert.strictEqual(kafka.max_evidence, 'discussed', 'repetition never promotes evidence');
});

test('same content overlap, 7 days apart: temporal decay + continuation window kill the suggestion', () => {
  const mk = (created, last, continuation) => [
    mkState({
      cwd: 'C:\\eng\\alpha',
      gitRoot: 'C:\\eng\\alpha',
      created: '2026-08-01T10:00:00.000Z',
      last: '2026-08-01T12:00:00.000Z',
      cls: cls('billing pipeline', [['Kafka', 'hands_on']]),
    }),
    mkState({
      cwd: 'C:\\eng\\beta',
      gitRoot: 'C:\\eng\\beta',
      created,
      last,
      cls: cls('billing exporter', [['Kafka', 'hands_on']], { continuation }),
    }),
  ];
  // Partial hint overlap (billing) + full tech overlap is NOT enough on its
  // own — the suggestion needs temporal proximity and the continuation bonus.
  const near = groupSessions(mk('2026-08-01T13:00:00.000Z', '2026-08-01T14:00:00.000Z', true), EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(near.projects.flatMap((p) => p.suggested_merges).length, 1, 'close-range continuation pair not suggested');

  const far = groupSessions(mk('2026-08-08T13:00:00.000Z', '2026-08-08T14:00:00.000Z', true), EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  assert.strictEqual(far.projects.flatMap((p) => p.suggested_merges).length, 0, 'week-apart pair should decay below threshold');
});

test('stopword-only hints contribute nothing — and gate the continuation bonus off entirely', () => {
  const a = mkState({
    cwd: 'C:\\eng\\gamma',
    gitRoot: 'C:\\eng\\gamma',
    created: '2026-08-01T10:00:00.000Z',
    last: '2026-08-01T12:00:00.000Z',
    cls: cls('new client project app', [['Kafka', 'hands_on']]),
  });
  const b = mkState({
    cwd: 'C:\\eng\\delta',
    gitRoot: 'C:\\eng\\delta',
    created: '2026-08-01T13:00:00.000Z',
    last: '2026-08-01T14:00:00.000Z',
    cls: cls('the client app', [['Kafka', 'hands_on']], { continuation: true }),
  });
  const { projects } = groupSessions([a, b], EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  // Same tech, same day, explicit continuation — but every hint token is a
  // stopword, so hint overlap is 0, which also disables the continuation
  // bonus: tech 0.25 + temporal ~0.15 stays far below the 0.6 threshold.
  assert.strictEqual(projects.flatMap((p) => p.suggested_merges).length, 0);
});
