'use strict';
// Invariants of the practitioner-experience layer (Task 4): experience counts
// DISTINCT PROJECTS, never sessions; learning/personal never accrue; singleton
// catch-alls contribute at most one flagged misc credit; the org rollup never
// double-counts a shared engagement; uncertainty survives aggregation raw.
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-exp-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { groupSessions, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS } = require('../src/grouping-core');
const { computeExperience } = require('../src/experience-core');

let n = 0;
function mkState({
  cwd,
  gitRoot = null,
  machine = null,
  created = '2026-08-01T10:00:00.000Z',
  last = null,
  cls = null,
  sid = null,
}) {
  return {
    session_id: sid || `exp-${n++}`,
    machine_id: machine,
    created_at: created,
    last_event_at: last || created,
    primary_cwd: cwd,
    git_root: gitRoot,
    counts: { prompts: 1, turns: 1, tool_uses: 0, subagent_events: 0, events: 2 },
    classification: cls,
  };
}

function cls(
  techs,
  {
    category = 'internal_work',
    professional = true,
    depth = 'substantive',
    confidence = 0.8,
    via = 'claude-cli',
    industry = [],
    hint = 'x',
    bcaps = [],
  } = {}
) {
  return {
    professional_work: professional,
    work_category: category,
    work_depth: depth,
    confidence,
    industry,
    tasks: [],
    project_hint: hint,
    business_capabilities: bcaps.map((id) => ({ id, name: id, domain: 'Test domain' })),
    technologies: techs.map(([name, evidence, verified = false]) => ({
      name,
      evidence,
      basis: verified ? ['tool:test'] : ['semantic'],
      verified,
    })),
    _meta: { classifier: via },
  };
}

function experience(states, corrections = EMPTY_CORRECTIONS, opts = {}) {
  const grouped = groupSessions(states, corrections, WINDOWS_PATH_OPTS);
  return computeExperience(states, grouped, corrections, opts);
}

function cap(doc, canonical) {
  return doc.capabilities.find((c) => c.canonical === canonical);
}

test('session volume never inflates: 50 discussed sessions in one project = 1 project at discussed', () => {
  const states = [];
  for (let i = 0; i < 50; i++) {
    states.push(
      mkState({
        cwd: 'C:\\work\\big',
        gitRoot: 'C:\\work\\big',
        cls: cls([['Kafka', 'discussed']]),
      })
    );
  }
  const { practitioners } = experience(states);
  const kafka = cap(practitioners[0], 'kafka');
  assert.strictEqual(kafka.distinct_projects, 1);
  assert.strictEqual(kafka.max_evidence, 'discussed', 'repetition never promotes evidence');
  assert.strictEqual(kafka.verified_projects, 0);
  assert.strictEqual(practitioners[0].totals.projects, 1);
});

test('verified separation: unverified hands_on projects never count as verified', () => {
  const states = [
    mkState({ cwd: 'C:\\w\\a', gitRoot: 'C:\\w\\a', cls: cls([['React', 'hands_on', false]]) }),
    mkState({ cwd: 'C:\\w\\b', gitRoot: 'C:\\w\\b', cls: cls([['React', 'hands_on', false]]) }),
    mkState({ cwd: 'C:\\w\\c', gitRoot: 'C:\\w\\c', cls: cls([['React', 'hands_on', false]]) }),
    mkState({ cwd: 'C:\\w\\d', gitRoot: 'C:\\w\\d', cls: cls([['React', 'hands_on', true]]) }),
  ];
  const { practitioners } = experience(states);
  const react = cap(practitioners[0], 'react');
  assert.strictEqual(react.distinct_projects, 4);
  assert.strictEqual(react.verified_projects, 1);
  assert.strictEqual(react.verified_max_evidence, 'hands_on');
  const verifiedEntries = react.projects.filter((p) => p.verified);
  assert.strictEqual(verifiedEntries.length, 1);
});

test('learning and personal never accrue capability experience; label corrections win both ways', () => {
  const learning = mkState({
    cwd: 'C:\\w\\learn',
    gitRoot: 'C:\\w\\learn',
    cls: cls([['Rust', 'hands_on', true]], { category: 'learning' }),
  });
  const personal = mkState({
    cwd: 'C:\\w\\pers',
    gitRoot: 'C:\\w\\pers',
    cls: cls([['Python', 'hands_on', true]], { category: 'personal' }),
  });
  const work = mkState({
    cwd: 'C:\\w\\real',
    gitRoot: 'C:\\w\\real',
    cls: cls([['Go', 'hands_on', true]], { category: 'client_work' }),
  });
  const { practitioners } = experience([learning, personal, work]);
  const doc = practitioners[0];
  assert.strictEqual(cap(doc, 'rust'), undefined, 'learning excluded');
  assert.strictEqual(cap(doc, 'python'), undefined, 'personal excluded');
  assert.ok(cap(doc, 'go'), 'client work included');
  assert.strictEqual(doc.totals.excluded.learning, 1);
  assert.strictEqual(doc.totals.excluded.personal, 1);
  assert.strictEqual(doc.totals.projects, 1, 'only the professional project counts');

  // Label flips inclusion in BOTH directions.
  const corrections = {
    ...EMPTY_CORRECTIONS,
    sessions: {
      [learning.session_id]: { label: 'internal_work' },
      [work.session_id]: { label: 'personal' },
    },
  };
  const flipped = experience([learning, personal, work], corrections).practitioners[0];
  assert.ok(cap(flipped, 'rust'), 'label promoted learning to internal work');
  assert.strictEqual(cap(flipped, 'go'), undefined, 'label demoted client work to personal');

  // `ignore` removes the session entirely (grouping filters it).
  const ignored = experience([work], {
    ...EMPTY_CORRECTIONS,
    sessions: { [work.session_id]: { label: 'ignore' } },
  });
  assert.strictEqual(ignored.practitioners.length, 0);

  // field_overrides are respected via effectiveClassification.
  const overridden = experience([work], {
    ...EMPTY_CORRECTIONS,
    sessions: { [work.session_id]: { field_overrides: { work_category: 'learning' } } },
  }).practitioners[0];
  assert.strictEqual(cap(overridden, 'go'), undefined, 'field override excluded the session');
});

test('org rollup: two practitioners on one shared project = 1 project each AND 1 org project', () => {
  const a = mkState({
    cwd: 'C:\\team\\shared',
    gitRoot: 'C:\\team\\shared',
    machine: 'm1',
    cls: cls([['MongoDB', 'hands_on', true]]),
  });
  const b = mkState({
    cwd: 'C:\\team\\shared',
    gitRoot: 'C:\\team\\shared',
    machine: 'm2',
    cls: cls([['MongoDB', 'hands_on', true]]),
  });
  const { practitioners, org } = experience([a, b], EMPTY_CORRECTIONS, {
    practitionerOf: (s) => s.machine_id,
  });
  assert.strictEqual(practitioners.length, 2);
  for (const doc of practitioners) {
    assert.strictEqual(cap(doc, 'mongodb').distinct_projects, 1);
    assert.strictEqual(doc.totals.projects, 1);
  }
  assert.strictEqual(
    cap(org, 'mongodb').distinct_projects,
    1,
    'org never sums per-practitioner counts'
  );
  assert.strictEqual(org.totals.projects, 1);
  assert.strictEqual(org.totals.sessions, 2);
});

test('all singleton catch-all work combined yields at most ONE flagged misc credit per capability', () => {
  const states = [];
  for (let i = 0; i < 5; i++) {
    states.push(
      mkState({
        cwd: 'C:\\Users\\sampleuser',
        cls: cls([['PowerShell', 'hands_on', true]], { hint: `chore ${i}` }),
      })
    );
  }
  const real = mkState({
    cwd: 'C:\\w\\infra',
    gitRoot: 'C:\\w\\infra',
    cls: cls([['PowerShell', 'hands_on', true]]),
  });
  const { practitioners } = experience([...states, real]);
  const doc = practitioners[0];
  const ps = cap(doc, 'powershell');
  assert.strictEqual(ps.distinct_projects, 2, 'one real project + one misc bucket');
  const misc = ps.projects.find((p) => p.misc);
  assert.ok(misc, 'misc trace entry exists');
  assert.strictEqual(misc.project_id, 'misc');
  assert.strictEqual(misc.sessions, 5, 'misc bucket still shows its session volume');
  assert.strictEqual(doc.totals.projects, 1, 'singletons are never counted as projects');
  assert.strictEqual(doc.totals.excluded.misc_sessions, 5);
});

test('uncertainty propagates raw: provenance flags, min confidence, membership kind, provisional identity', () => {
  const solid = mkState({
    cwd: 'C:\\w\\solid',
    gitRoot: 'C:\\w\\solid',
    machine: 'm1',
    cls: cls([['Node.js', 'hands_on', true]], { confidence: 0.9 }),
  });
  const shaky = mkState({
    cwd: 'C:\\w\\shaky',
    gitRoot: 'C:\\w\\shaky',
    machine: 'm1',
    cls: cls([['Node.js', 'discussed']], { confidence: 0.3, via: 'heuristic' }),
  });
  const inherited = mkState({
    cwd: 'C:\\w\\inh',
    gitRoot: 'C:\\w\\inh',
    machine: 'm1',
    cls: cls([['Node.js', 'discussed']], { confidence: 0.5, via: 'inherited' }),
  });
  const { practitioners } = experience([solid, shaky, inherited], EMPTY_CORRECTIONS, {
    practitionerOf: (s) => s.machine_id,
    practitionerMeta: (key) => ({
      id: 'machine:' + key,
      display_name: 'sampleuser',
      provisional: true,
    }),
  });
  const doc = practitioners[0];
  assert.strictEqual(doc.practitioner.provisional, true);
  const node = cap(doc, 'node.js');
  assert.strictEqual(node.uncertainty.any_heuristic, true);
  assert.strictEqual(node.uncertainty.any_inherited, true);
  assert.strictEqual(node.uncertainty.min_confidence, 0.3);
  assert.ok(node.projects.every((p) => p.key_kind === 'git_root'));
  // The trace keeps per-project provenance so a display layer can filter.
  const shakyEntry = node.projects.find((p) => p.classifiers.includes('heuristic'));
  assert.ok(shakyEntry && !shakyEntry.verified);
});

test('every capability count is backed by trace entries whose session ids resolve', () => {
  const states = [
    mkState({
      cwd: 'C:\\w\\a',
      gitRoot: 'C:\\w\\a',
      cls: cls([
        ['TypeScript', 'hands_on', true],
        ['Redis', 'discussed'],
      ]),
    }),
    mkState({ cwd: 'C:\\w\\a', gitRoot: 'C:\\w\\a', cls: cls([['TypeScript', 'discussed']]) }),
    mkState({
      cwd: 'C:\\w\\b',
      gitRoot: 'C:\\w\\b',
      cls: cls([['TypeScript', 'hands_on', false]]),
    }),
  ];
  const byId = new Set(states.map((s) => s.session_id));
  const { practitioners, org } = experience(states);
  for (const doc of [practitioners[0], org]) {
    for (const c of doc.capabilities) {
      assert.strictEqual(
        c.distinct_projects,
        c.projects.length,
        `${c.canonical}: count backed by trace`
      );
      assert.strictEqual(c.verified_projects, c.projects.filter((p) => p.verified).length);
      for (const entry of c.projects) {
        assert.ok(entry.session_ids.length > 0);
        for (const sid of entry.session_ids) assert.ok(byId.has(sid), 'trace session id resolves');
      }
    }
  }
  const ts = cap(practitioners[0], 'typescript');
  assert.strictEqual(ts.distinct_projects, 2);
  assert.strictEqual(ts.verified_projects, 1);
});
