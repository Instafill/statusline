'use strict';
// The normalization tables are the thin-client contract: names collapse the
// same way on every machine and in the cloud. These probes pin the mechanics
// (char subs, compound splitting, suffix drops, MCP ids) and the overlay
// validation that guards the server→client trust boundary.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS,
  createNormalizer,
  mergeTables,
  validateOverlay,
} = require('../src/tech-normalize');

const norm = createNormalizer(DEFAULTS);

test('display-form variants collapse to canonical capabilities', () => {
  const cases = [
    ['TypeScript', ['typescript']],
    ['Node.js', ['nodejs']],
    ['C#', ['csharp']],
    ['C# / .NET', ['csharp', 'dotnet']],
    ['.NET / ASP.NET Core', ['dotnet']],
    ['ASP.NET Core MVC', ['dotnet']],
    ['Razor/.cshtml', ['dotnet']],
    ['Google Search Console API', ['googlesearchconsole']],
    ['GitHub CLI (gh)', ['github']],
    ['Git/GitHub', ['git', 'github']],
    ['MongoDB Atlas', ['mongodb']],
    ['Azure App Service', ['azure']],
    ['Azure CLI', ['azure']],
    ['C++', ['cpp']],
    ['Excel/XLSX', ['excel']],
    ['Postgres', ['postgresql']],
  ];
  for (const [input, expected] of cases) {
    assert.deepStrictEqual(
      norm.canonicalsOf(input),
      expected,
      `canonicalsOf(${JSON.stringify(input)})`
    );
  }
});

test('MCP server ids lose transport prefix and qualifier suffixes', () => {
  assert.deepStrictEqual(norm.canonicalsOf('claude_ai_Fireflies'), ['fireflies']);
  assert.deepStrictEqual(norm.canonicalsOf('claude_ai_Acme_ai_MCP'), ['acmeai']);
  assert.deepStrictEqual(norm.canonicalsOf('Acme.ai MCP'), ['acmeai']); // LLM display form matches the id
  assert.deepStrictEqual(norm.canonicalsOf('TrustMRR MCP server'), ['trustmrr']);
});

test('suffix dropping never eats single-token names', () => {
  assert.deepStrictEqual(norm.canonicalsOf('fastapi'), ['fastapi']); // NOT 'fast'
  assert.deepStrictEqual(norm.canonicalsOf('mcp'), ['mcp']);
  assert.deepStrictEqual(norm.canonicalsOf('cli'), ['cli']);
});

test('distinct technologies never conflate (the old substring hole)', () => {
  assert.notDeepStrictEqual(norm.canonicalsOf('Java'), norm.canonicalsOf('JavaScript'));
  assert.deepStrictEqual(norm.canonicalsOf('Java'), ['java']);
});

test('overlay merge: server entries win, defaults survive, version follows overlay', () => {
  const merged = mergeTables(DEFAULTS, { version: 7, aliases: { bun: 'nodejs', go: 'go-lang' } });
  const n2 = createNormalizer(merged);
  assert.strictEqual(n2.version, 7);
  assert.deepStrictEqual(n2.canonicalsOf('bun'), ['nodejs']); // added
  assert.deepStrictEqual(n2.canonicalsOf('go'), ['go-lang']); // overridden
  assert.deepStrictEqual(n2.canonicalsOf('Postgres'), ['postgresql']); // default survives
});

test('overlay validation drops hostile or malformed entries', () => {
  const v = validateOverlay({
    version: 2,
    aliases: {
      good: 'fine',
      'BAD KEY!': 'x',
      injection: '<script>alert(1)</script>',
      huge: 'y'.repeat(200),
    },
    ext_tech: { '.astro': 'astro', 'no-dot': 'nope' },
    cmd_tech: { bun: 'nodejs' },
    unknown_section: { evil: 'yes' },
  });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(Object.keys(v.value.aliases), ['good']);
  assert.deepStrictEqual(v.value.ext_tech, { '.astro': 'astro' });
  assert.deepStrictEqual(v.value.cmd_tech, { bun: 'nodejs' });
  assert.strictEqual(v.value.unknown_section, undefined); // unknown keys never pass through
  assert.ok(v.errors.length >= 3);

  assert.strictEqual(validateOverlay(null).ok, false);
  assert.strictEqual(validateOverlay({ aliases: {} }).ok, false); // version required
  assert.strictEqual(validateOverlay([1, 2]).ok, false);
});
