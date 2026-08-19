'use strict';
// Invariants of the business-capability axis (Experience v2): same
// anti-inflation discipline as technologies (distinct projects, misc ≤1,
// non-professional work earns nothing, uncertainty raw) plus the honesty
// tier that is unique to this axis — a business capability can be GROUNDED
// (tool-verified activity behind the claim) but NEVER "verified", and the
// naming discipline is pinned here so a refactor cannot quietly erode it.
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-bcap-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { groupSessions, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS } = require('../src/grouping-core');
const { computeExperience } = require('../src/experience-core');

let n = 0;
function mkState({ cwd, gitRoot = null, created = '2026-08-01T10:00:00.000Z', cls = null }) {
  return {
    session_id: `bcap-${n++}`,
    machine_id: null,
    created_at: created,
    last_event_at: created,
    primary_cwd: cwd,
    git_root: gitRoot,
    counts: { prompts: 1, turns: 1, tool_uses: 0, subagent_events: 0, events: 2 },
    classification: cls,
  };
}

function cls({ category = 'internal_work', via = 'claude-cli', confidence = 0.8, industry = [], bcaps = [], techs = [] } = {}) {
  return {
    professional_work: category === 'client_work' || category === 'internal_work',
    work_category: category,
    work_depth: 'substantive',
    confidence,
    industry,
    tasks: [],
    project_hint: 'x',
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

function experience(states) {
  const grouped = groupSessions(states, EMPTY_CORRECTIONS, WINDOWS_PATH_OPTS);
  return computeExperience(states, grouped, EMPTY_CORRECTIONS, {});
}

function bcap(doc, id) {
  return (doc.business_capabilities || []).find((c) => c.id === id);
}

test('business capabilities count DISTINCT projects — session volume never inflates', () => {
  const states = [];
  for (let i = 0; i < 20; i++) {
    states.push(mkState({ cwd: 'C:\\w\\growth', gitRoot: 'C:\\w\\growth', cls: cls({ bcaps: ['email-outreach'] }) }));
  }
  const { practitioners } = experience(states);
  const c = bcap(practitioners[0], 'email-outreach');
  assert.strictEqual(c.distinct_projects, 1);
  assert.strictEqual(c.domain, 'Test domain');
});

test('grounded requires tool-verified tech in a contributing session; "verified" never appears', () => {
  const states = [
    mkState({ cwd: 'C:\\w\\a', gitRoot: 'C:\\w\\a', cls: cls({ bcaps: ['lead-generation'], techs: [['Python', 'hands_on', true]] }) }),
    mkState({ cwd: 'C:\\w\\b', gitRoot: 'C:\\w\\b', cls: cls({ bcaps: ['lead-generation'], techs: [['Python', 'hands_on', false]] }) }),
  ];
  const { practitioners } = experience(states);
  const c = bcap(practitioners[0], 'lead-generation');
  assert.strictEqual(c.distinct_projects, 2);
  assert.strictEqual(c.grounded_projects, 1, 'only the tool-corroborated project is grounded');
  // Naming discipline IS the enforcement of the honesty tier.
  const offending = (obj) => Object.keys(obj).filter((k) => /verified/i.test(k));
  assert.deepStrictEqual(offending(c), [], 'no verified-named key on the capability');
  for (const p of c.projects) assert.deepStrictEqual(offending(p), [], 'no verified-named key on the trace');
});

test('non-professional and unknown-category sessions earn no business capability credit', () => {
  const states = [
    mkState({ cwd: 'C:\\w\\l', gitRoot: 'C:\\w\\l', cls: cls({ category: 'learning', bcaps: ['seo-diagnostics'] }) }),
    mkState({ cwd: 'C:\\w\\p', gitRoot: 'C:\\w\\p', cls: cls({ category: 'personal', bcaps: ['seo-diagnostics'] }) }),
    // Heuristic fallbacks emit empty capabilities by construction; even a
    // hypothetical doc carrying both unknown category and picks must not count.
    mkState({ cwd: 'C:\\w\\u', gitRoot: 'C:\\w\\u', cls: cls({ category: 'unknown', via: 'heuristic', bcaps: ['seo-diagnostics'] }) }),
  ];
  const { practitioners } = experience(states);
  assert.strictEqual(bcap(practitioners[0], 'seo-diagnostics'), undefined);
});

test('singleton catch-alls collapse to ONE misc business-capability credit', () => {
  const states = [];
  for (let i = 0; i < 4; i++) {
    states.push(mkState({ cwd: 'C:\\Users\\sampleuser', cls: cls({ bcaps: ['cloud-operations'] }) }));
  }
  const { practitioners } = experience(states);
  const c = bcap(practitioners[0], 'cloud-operations');
  assert.strictEqual(c.distinct_projects, 1, 'all singleton work = one flagged misc credit');
  assert.strictEqual(c.projects[0].misc, true);
  assert.strictEqual(c.projects[0].sessions, 4);
});

test('inherited provenance and min confidence ride raw', () => {
  const states = [
    mkState({ cwd: 'C:\\w\\i', gitRoot: 'C:\\w\\i', cls: cls({ via: 'inherited', confidence: 0.4, bcaps: ['billing-systems'] }) }),
    mkState({ cwd: 'C:\\w\\i', gitRoot: 'C:\\w\\i', cls: cls({ confidence: 0.9, bcaps: ['billing-systems'] }) }),
  ];
  const { practitioners } = experience(states);
  const c = bcap(practitioners[0], 'billing-systems');
  assert.strictEqual(c.uncertainty.any_inherited, true);
  assert.strictEqual(c.uncertainty.min_confidence, 0.4);
});

test('industries live on totals, never on capability rows', () => {
  const states = [
    mkState({ cwd: 'C:\\w\\x', gitRoot: 'C:\\w\\x', cls: cls({ industry: ['real estate'], bcaps: ['lead-generation'], techs: [['Python', 'hands_on', true]] }) }),
  ];
  const { practitioners } = experience(states);
  const doc = practitioners[0];
  assert.deepStrictEqual(doc.totals.industries, ['real estate']);
  assert.strictEqual('industries' in doc.capabilities.find((c) => c.canonical === 'python'), false);
  assert.strictEqual('industries' in bcap(doc, 'lead-generation'), false);
});

test('capability_coverage counts capability-eligible professional sessions; heuristic and non-professional excluded', () => {
  const states = [
    mkState({ cwd: 'C:\p\a', gitRoot: 'C:\p\a', cls: cls({ bcaps: ['process-automation'] }) }), // covered
    mkState({ cwd: 'C:\p\a', gitRoot: 'C:\p\a', cls: cls({ bcaps: [] }) }), // eligible, uncovered
    mkState({ cwd: 'C:\p\a', gitRoot: 'C:\p\a', cls: cls({ via: 'heuristic', bcaps: [] }) }), // heuristic: not eligible
    mkState({ cwd: 'C:\p\a', gitRoot: 'C:\p\a', cls: cls({ category: 'learning', bcaps: [] }) }), // not professional
    mkState({ cwd: 'C:\p\a', gitRoot: 'C:\p\a', cls: cls({ via: 'inherited', bcaps: ['process-automation'] }) }), // inherited counts
  ];
  const { practitioners } = experience(states);
  const cov = practitioners[0].totals.capability_coverage;
  assert.deepStrictEqual(cov, { eligible: 3, covered: 2 });
});
