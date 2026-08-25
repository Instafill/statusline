'use strict';
// Classifier CLI resolution, and the spawn that follows it. A LaunchAgent
// inherits /usr/bin:/bin:/usr/sbin:/sbin, on which no directory Claude Code
// installs into appears, so a PATH lookup alone leaves the bare name and spawn
// fails with ENOENT. These tests run against that PATH.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-cli-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const {
  LAUNCHD_PATH,
  tempHome,
  writeFakeCli,
  writeFallbackCli,
  withEnv,
  underLaunchdPath,
} = require('./helpers/launchd');

const NOT_WINDOWS = { skip: process.platform === 'win32' };

/**
 * Resolution is memoized per process, so every probing test needs its own copy
 * of the module or it reads the previous test's answer.
 * @returns {typeof import('../src/classify/claude-cli')}
 */
function freshAdapter() {
  delete require.cache[require.resolve('../src/classify/claude-cli')];
  return require('../src/classify/claude-cli');
}

test('an explicit cli_path is used verbatim, with no probing', () => {
  // Deliberately a path that does not exist: an operator who names a location
  // is answering the question, and resolution must not second-guess them.
  const configured = path.join(TESTHOME, 'nowhere', 'my-claude');
  assert.strictEqual(freshAdapter().resolveClassifierCli(configured), configured);
});

test('a CLI on PATH resolves to its absolute path without probing', NOT_WINDOWS, async () => {
  const home = tempHome();
  const onPath = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-bin-'));
  const expected = writeFakeCli(onPath);

  // A second copy in the fallback location proves which one won.
  writeFallbackCli(home);

  const resolved = await withEnv({ HOME: home, PATH: `${onPath}:${LAUNCHD_PATH}` }, () =>
    freshAdapter().resolveClassifierCli('claude')
  );

  assert.strictEqual(resolved, expected);
});

test('nothing anywhere resolves to nothing', NOT_WINDOWS, async () => {
  const resolved = await underLaunchdPath(tempHome(), () =>
    freshAdapter().resolveClassifierCli('claude')
  );

  assert.strictEqual(resolved, null);
});

test('a CLI off PATH but in ~/.local/bin still resolves', NOT_WINDOWS, async () => {
  const home = tempHome();
  const expected = writeFallbackCli(home);

  const resolved = await underLaunchdPath(home, () =>
    freshAdapter().resolveClassifierCli('claude')
  );

  assert.strictEqual(resolved, expected);
});

test('a file of the right name that is not executable does not resolve', NOT_WINDOWS, async () => {
  const home = tempHome();
  const dir = path.join(home, '.local', 'bin');

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude'), 'not a program');

  // Resolution reports absence rather than handing back a path that cannot run.
  const resolved = await underLaunchdPath(home, () =>
    freshAdapter().resolveClassifierCli('claude')
  );

  assert.strictEqual(resolved, null);
});

test(
  'a CLI reached only through the fallback still classifies end to end',
  NOT_WINDOWS,
  async () => {
    // Covers resolution, spawn, stdin delivery and envelope parsing as one
    // chain, so that a path which resolves but cannot execute still fails here.
    const home = tempHome();
    writeFallbackCli(
      home,
      `cat > /dev/null\nprintf '%s' '{"is_error":false,"result":"{\\"ok\\":true}"}'`
    );

    const cfg = { model: 'opus', cli_path: 'claude', timeout_ms: 20_000 };
    const res = await underLaunchdPath(home, () => freshAdapter().attempt('classify this', cfg));

    assert.strictEqual(res.outcome, 'ok');
    assert.deepStrictEqual(res.json, { ok: true });
  }
);
