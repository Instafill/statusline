// @ts-check
'use strict';
// Moves the version in every manifest that carries it. Run as `npm run bump` or
// `bun run bump`, either interactively or with the bump kind as an argument.
// The only thing it touches is those files. Tagging and pushing stay manual.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/** Every file carrying the app version. They must always agree. */
const VERSION_FILES = [
  'package.json',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.codex-plugin/plugin.json',
];

/** @typedef {'patch' | 'minor' | 'major'} BumpKind */

/** @type {BumpKind[]} */
const KINDS = ['patch', 'minor', 'major'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Group 1 is the spacing after the colon, group 2 the version itself. */
const VERSION_FIELD = /"version":(\s*)"([^"]+)"/;

/** The blank line and the hint the picker prints below the kinds. */
const HINT_LINES = 2;

const KIND_COLUMN = 7;
const FILE_COLUMN = 34;

/**
 * @param {string} current
 * @param {BumpKind} kind
 * @returns {string}
 */
function nextVersion(current, kind) {
  const parts = SEMVER.exec(current);

  if (!parts) throw new Error(`not a SemVer version: ${current}`);

  const [major, minor, patch] = parts.slice(1).map(Number);

  if (kind === 'major') return `${major + 1}.0.0`;

  if (kind === 'minor') return `${major}.${minor + 1}.0`;

  return `${major}.${minor}.${patch + 1}`;
}

/**
 * @param {string} root
 * @returns {{file: string, version: string, content: string}[]}
 */
function readVersions(root) {
  return VERSION_FILES.map((file) => {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    const found = VERSION_FIELD.exec(content);

    if (!found) throw new Error(`no version field in ${file}`);

    return { file, version: found[2], content };
  });
}

/**
 * Writes the next version into every manifest. When the manifests already carry
 * different versions, it throws with all three values listed and writes nothing,
 * leaving the choice of the correct one to a human.
 * @param {string} root
 * @param {BumpKind} kind
 * @returns {{from: string, to: string, files: string[]}}
 */
function bump(root, kind) {
  const found = readVersions(root);
  const distinct = [...new Set(found.map((f) => f.version))];

  if (distinct.length > 1) {
    const listed = found.map((f) => `  ${f.file.padEnd(FILE_COLUMN)} ${f.version}`).join('\n');
    throw new Error(`the manifests disagree about the current version:\n${listed}`);
  }

  const from = found[0].version;
  const to = nextVersion(from, kind);

  for (const { file, content } of found) {
    // Targeted replacement rather than rewriting the whole document, so the
    // diff is one line per file.
    const updated = content.replace(VERSION_FIELD, `"version":$1"${to}"`);
    fs.writeFileSync(path.join(root, file), updated);
  }

  return { from, to, files: VERSION_FILES };
}

/**
 * Bumps the manifests and reports it on stdout: the version transition, the
 * files written, and the `git tag` command to run afterwards. Prints the tag
 * command without running it. Throws whatever `bump` throws.
 * @param {string} root
 * @param {BumpKind} kind
 * @returns {void}
 */
function apply(root, kind) {
  const res = bump(root, kind);

  process.stdout.write(`\n  ${res.from} -> ${res.to}\n`);

  for (const file of res.files) process.stdout.write(`  updated ${file}\n`);

  process.stdout.write('\n  Tag it yourself once the change is committed:\n');
  process.stdout.write(`    git tag -a v${res.to} -m "v${res.to}" && git push --tags\n\n`);
}

/**
 * Arrow-key picker.
 * @param {string} current
 * @returns {Promise<BumpKind | null>} the chosen kind, or null when canceled
 */
function choose(current) {
  return new Promise((resolve) => {
    let selected = 0;
    let drawn = false;

    const render = () => {
      if (drawn) process.stdout.write(`[${KINDS.length + HINT_LINES}A`);

      for (const [i, kind] of KINDS.entries()) {
        const marker = i === selected ? '>' : ' ';
        process.stdout.write(
          `[2K  ${marker} ${kind.padEnd(KIND_COLUMN)} ${current} -> ${nextVersion(current, kind)}\n`
        );
      }

      process.stdout.write('[2K\n[2K  up/down select, enter confirm, q cancel\n');
      drawn = true;
    };

    /** @param {BumpKind | null} value */
    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(value);
    };

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    process.stdin.on('keypress', (_str, key) => {
      if (key.name === 'up') selected = (selected + KINDS.length - 1) % KINDS.length;
      else if (key.name === 'down') selected = (selected + 1) % KINDS.length;
      else if (key.name === 'return') return done(KINDS[selected]);
      else if (key.name === 'q' || (key.ctrl && key.name === 'c')) return done(null);
      else return;

      render();
    });
  });
}

/**
 * Entry point. With a kind as argument it applies it, otherwise it asks.
 * @returns {Promise<void>}
 */
async function main() {
  const root = path.resolve(__dirname, '..');
  const [requested] = process.argv.slice(2);

  if (requested && !KINDS.includes(/** @type {BumpKind} */ (requested))) {
    process.stderr.write(`unknown bump: ${requested} (expected patch, minor or major)\n`);
    process.exitCode = 1;
    return;
  }

  if (requested) return apply(root, /** @type {BumpKind} */ (requested));

  const [{ version }] = readVersions(root);

  process.stdout.write(`\n  Current version: ${version}\n\n`);

  const kind = await choose(version);

  if (!kind) {
    process.stdout.write('\n  Canceled.\n\n');
    return;
  }

  apply(root, kind);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exitCode = 1;
  });
}

module.exports = { nextVersion, readVersions, bump, VERSION_FILES };
