'use strict';
// The version lives in three manifests that must always agree. The bump is the
// one place that moves them together, and it refuses rather than decides when
// they have already drifted apart.
const os = require('os');
const path = require('path');
const fs = require('fs');

const { test } = require('node:test');
const assert = require('node:assert');
const { nextVersion, bump, VERSION_FILES } = require('../scripts/bump-version');

/**
 * A throwaway repo carrying every manifest at the given versions.
 * @param {[string, string, string, string]} versions package, claude plugin,
 *   marketplace, codex plugin
 * @returns {string} the repo root
 */
function repoAt(versions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-bump-'));

  fs.mkdirSync(path.join(root, '.claude-plugin'));
  fs.mkdirSync(path.join(root, '.codex-plugin'));
  fs.writeFileSync(
    path.join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'statusline', version: versions[3] }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'statusline', version: versions[0], private: true }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'statusline', version: versions[1] }, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      { name: 'statusline', plugins: [{ name: 'statusline', source: './', version: versions[2] }] },
      null,
      2
    ) + '\n'
  );

  return root;
}

const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

test('a bump moves each part of the version on its own', () => {
  assert.strictEqual(nextVersion('0.3.4', 'patch'), '0.3.5');
  assert.strictEqual(nextVersion('0.3.4', 'minor'), '0.4.0');
  assert.strictEqual(nextVersion('0.3.4', 'major'), '1.0.0');
  assert.strictEqual(nextVersion('1.9.9', 'minor'), '1.10.0');
});

test('every manifest moves together', () => {
  const root = repoAt(['0.3.4', '0.3.4', '0.3.4', '0.3.4']);
  const res = bump(root, 'patch');

  assert.strictEqual(res.from, '0.3.4');
  assert.strictEqual(res.to, '0.3.5');

  for (const file of VERSION_FILES) {
    assert.match(read(root, file), /"version": "0\.3\.5"/, `${file} carries the new version`);
  }

  // Named outright rather than read off VERSION_FILES, so a manifest missing
  // from that list fails here instead of passing by not being looked at.
  for (const file of [
    'package.json',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
  ]) {
    assert.match(read(root, file), /"version": "0\.3\.5"/, `${file} carries the new version`);
  }
});

test('only the version line changes', () => {
  const root = repoAt(['0.3.4', '0.3.4', '0.3.4', '0.3.4']);
  const before = read(root, 'package.json');

  bump(root, 'patch');

  const after = read(root, 'package.json');
  const changed = after
    .split('\n')
    .filter((line, i) => line !== before.split('\n')[i])
    .map((l) => l.trim());

  assert.deepStrictEqual(changed, ['"version": "0.3.5",']);
});

test('a divergence is refused and every value is named', () => {
  const root = repoAt(['0.3.4', '0.3.4', '0.3.3', '0.3.4']);

  assert.throws(
    () => bump(root, 'patch'),
    (err) => {
      assert.match(err.message, /0\.3\.4/);
      assert.match(err.message, /0\.3\.3/);
      assert.match(err.message, /marketplace\.json/);
      return true;
    }
  );

  assert.match(read(root, 'package.json'), /"version": "0\.3\.4"/, 'nothing was written');
});
