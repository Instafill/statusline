'use strict';
// The capability-catalog contract: strict overlay validation (the catalog
// crosses a trust boundary INTO classifier prompts), deterministic derivation
// with the raw twin (rename/merge/add corrects history with zero LLM calls),
// the zero-turn gate, heuristic abstention, and strip pass-through.
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.STATUSLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-cap-'));

const { test } = require('node:test');
const assert = require('node:assert');
const caps = require('../src/capabilities');
const { validateOverlay } = require('../src/tech-normalize');
const teamConfig = require('../src/team-config');
const { deriveBusinessCapabilities } = require('../src/evidence');
const { stripContent } = require('../src/upload/strip');

function mkState(over = {}) {
  return {
    session_id: 'cap-sid',
    created_at: '2026-08-01T10:00:00.000Z',
    last_event_at: '2026-08-01T11:00:00.000Z',
    primary_cwd: 'C:\\proj\\demo',
    counts: { prompts: 1, turns: 1, tool_uses: 0, subagent_events: 0, events: 2 },
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

/* ------------------------------- pure module ------------------------------- */

test('resolveId chases aliases, guards cycles, and rejects unknown ids', () => {
  const tables = {
    catalog: { current: { name: 'Current' } },
    cap_aliases: { old: 'older', older: 'current', loop_a: 'loop_b', loop_b: 'loop_a' },
  };
  assert.strictEqual(caps.resolveId(tables, 'old'), 'current');
  assert.strictEqual(caps.resolveId(tables, 'CURRENT'), 'current', 'case-insensitive input');
  assert.strictEqual(caps.resolveId(tables, 'nope'), null);
  assert.strictEqual(
    caps.resolveId(tables, 'loop_a'),
    null,
    'alias cycle degrades to null, never hangs'
  );
});

test('activeEntries excludes retired (aliased) ids and sorts by id', () => {
  const tables = {
    catalog: { zebra: { name: 'Z' }, alpha: { name: 'A' }, retired: { name: 'R' } },
    cap_aliases: { retired: 'alpha' },
  };
  const ids = caps.activeEntries(tables).map((e) => e.id);
  assert.deepStrictEqual(ids, ['alpha', 'zebra']);
});

test('default catalog ids all satisfy the id charset and carry name+gloss+domain', () => {
  for (const [id, e] of Object.entries(caps.DEFAULTS.catalog)) {
    assert.ok(caps.ID_RE.test(id), `bad default id ${id}`);
    assert.ok(e.name && e.gloss && e.domain, `incomplete default entry ${id}`);
  }
});

/* --------------------------- overlay validation ---------------------------- */

test('overlay capability sections: injection charsets enforced entry-wise', () => {
  const v = validateOverlay({
    version: 3,
    capabilities: {
      'good-id': {
        name: 'Good Name',
        gloss: 'A fine gloss, with punctuation: yes.',
        domain: 'Growth',
      },
      'bad-gloss': { name: 'Ok', gloss: 'has <angle> brackets' },
      'bad-name': { name: 'Bad `tick`', gloss: 'x' },
      'no-name': { gloss: 'x' },
      'Bad Id': { name: 'x', gloss: 'x' },
    },
    cap_aliases: { 'old-id': 'good-id', BAD: 'good-id' },
    reclassify_capabilities_before: '2026-08-19T00:00:00Z',
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(Object.keys(v.value.capabilities), ['good-id']);
  assert.deepStrictEqual(Object.keys(v.value.cap_aliases), ['old-id']);
  assert.strictEqual(v.value.reclassify_capabilities_before, '2026-08-19T00:00:00Z');
  assert.ok(v.errors.length >= 4, 'each dropped entry leaves an error string');
});

test('invalid watermark and unknown sections: dropped, validation still passes (version-skew safety)', () => {
  const v = validateOverlay({
    version: 4,
    reclassify_capabilities_before: 'not a date',
    future_section: { a: 1 },
  });
  assert.strictEqual(v.ok, true);
  assert.strictEqual('reclassify_capabilities_before' in v.value, false);
  assert.strictEqual('future_section' in v.value, false);
});

/* ------------------------- deterministic derivation ------------------------ */

test('zero-turn sessions derive no capabilities; raw untouched and reversible', () => {
  const s = mkState({
    counts: { prompts: 1, turns: 0, tool_uses: 0, subagent_events: 0, events: 1 },
    classification: { business_capabilities_raw: ['process-automation'] },
  });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(s.classification.business_capabilities, []);
  assert.deepStrictEqual(
    s.classification.business_capabilities_raw,
    ['process-automation'],
    'raw untouched'
  );
  s.counts.turns = 1;
  deriveBusinessCapabilities(s);
  assert.strictEqual(
    s.classification.business_capabilities[0].id,
    'process-automation',
    'refold restores the claim'
  );
  assert.ok(
    s.classification.business_capabilities[0].domain,
    'derived entries carry display metadata'
  );
});

test('legacy classifications get an empty raw twin — nothing is fabricated', () => {
  const s = mkState({ classification: { work_category: 'internal_work' } });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(s.classification.business_capabilities_raw, []);
  assert.deepStrictEqual(s.classification.business_capabilities, []);
});

test('unknown ids survive in raw and resurrect when the catalog gains the entry', () => {
  const s = mkState({ classification: { business_capabilities_raw: ['made-up-capability'] } });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(
    s.classification.business_capabilities,
    [],
    'unknown id filtered from derived'
  );
  const res = teamConfig.store({
    version: 7,
    capabilities: {
      'made-up-capability': { name: 'Made Up Capability', gloss: 'Now it exists.', domain: 'Test' },
    },
  });
  assert.strictEqual(res.changed, true);
  deriveBusinessCapabilities(s);
  assert.strictEqual(
    s.classification.business_capabilities[0].id,
    'made-up-capability',
    'catalog addition is retroactive'
  );
});

test('catalog alias re-derives history with zero classifier calls', () => {
  const s = mkState({
    classification: { business_capabilities_raw: ['made-up-capability', 'process-automation'] },
  });
  const res = teamConfig.store({
    version: 8,
    cap_aliases: { 'made-up-capability': 'process-automation' },
  });
  assert.strictEqual(res.changed, true);
  deriveBusinessCapabilities(s);
  const ids = s.classification.business_capabilities.map((c) => c.id);
  assert.deepStrictEqual(ids, ['process-automation'], 'merged id deduped into its successor');
});

/* -------------------------- fallback and transport ------------------------- */

test('heuristic fallback never emits business capabilities', () => {
  const { heuristicClassification } = require('../src/classify/heuristic');
  const h = heuristicClassification(
    mkState({ counts: { prompts: 2, turns: 3, tool_uses: 9, subagent_events: 0, events: 20 } }),
    { reason: 'auth_error' }
  );
  assert.deepStrictEqual(h.business_capabilities, []);
  assert.deepStrictEqual(h.business_capabilities_raw, []);
});

test('stripContent preserves both capability fields (a strip regression would silently zero the axis fleet-wide)', () => {
  const doc = {
    session_id: 'x',
    prompts: [{ text: 'secret' }],
    classification: {
      business_capabilities: [
        {
          id: 'process-automation',
          name: 'Business process analysis & automation',
          domain: 'Business operations',
        },
      ],
      business_capabilities_raw: ['process-automation'],
    },
  };
  const out = stripContent(doc);
  assert.deepStrictEqual(out.prompts, []);
  assert.deepStrictEqual(out.classification.business_capabilities_raw, ['process-automation']);
  assert.strictEqual(out.classification.business_capabilities[0].id, 'process-automation');
});

/* --------------------------- catalog-gap telemetry ------------------------- */

test('unresolved ids are recorded in business_capabilities_dropped and clear when the catalog catches up', () => {
  const s = mkState({
    classification: {
      business_capabilities_raw: [
        'wiki-editorial-work',
        'process-automation',
        'Bad Id!',
        'wiki-editorial-work',
      ],
    },
  });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(
    s.classification.business_capabilities_dropped,
    ['wiki-editorial-work'],
    'well-formed unknown ids only, deduped; malformed junk excluded'
  );
  assert.strictEqual(s.classification.business_capabilities[0].id, 'process-automation');
  teamConfig.store({
    version: 9,
    capabilities: { 'wiki-editorial-work': { name: 'Wiki Editorial Work', domain: 'Test' } },
  });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(
    s.classification.business_capabilities_dropped,
    [],
    'catalog addition empties the gap sensor on refold'
  );
  assert.ok(s.classification.business_capabilities.some((c) => c.id === 'wiki-editorial-work'));
});

test('zero-turn sessions record no dropped ids (nothing was performed)', () => {
  const s = mkState({
    counts: { prompts: 1, turns: 0, tool_uses: 0, subagent_events: 0, events: 1 },
    classification: { business_capabilities_raw: ['some-unknown-thing'] },
  });
  deriveBusinessCapabilities(s);
  assert.deepStrictEqual(s.classification.business_capabilities_dropped, []);
});

test('stripContent preserves business_capabilities_dropped (the fleet catalog-gap tally reads it)', () => {
  const doc = {
    session_id: 'x',
    prompts: [{ text: 'secret' }],
    classification: { business_capabilities_dropped: ['wiki-editorial-work'] },
  };
  const out = stripContent(doc);
  assert.deepStrictEqual(out.classification.business_capabilities_dropped, ['wiki-editorial-work']);
});

test('schema caps business_capabilities at 4 — matching the prompt instruction', () => {
  const { validate } = require('../src/classify/schema');
  const v = validate({
    professional_work: true,
    confidence: 0.9,
    technologies: [],
    business_capabilities: ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6'],
  });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.value.business_capabilities.length, 4);
});
