// @ts-check
'use strict';
// Shared setup for the tests that reproduce a LaunchAgent's environment.
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * What launchd hands a LaunchAgent and nothing more. `resolveCommand` in
 * src/util/platform.js shells out to `which`, which lives in /usr/bin, so the
 * lookup still runs against this PATH and finds no `claude`.
 */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** @returns {string} a fresh empty directory to stand in for a home */
function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-home-'));
}

/**
 * Writes an executable named `claude` into a directory.
 * @param {string} dir
 * @param {string} [body] shell script body, defaulting to a harmless stub
 * @returns {string} absolute path to the executable
 */
function writeFakeCli(dir, body = 'echo fake') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'claude');

  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);

  return file;
}

/**
 * The same executable, in the install directory a PATH lookup cannot reach.
 * @param {string} home
 * @param {string} [body]
 * @returns {string} absolute path to the executable
 */
function writeFallbackCli(home, body) {
  return writeFakeCli(path.join(home, '.local', 'bin'), body);
}

/**
 * Runs `fn` with these environment variables, then restores them. Awaits the
 * result so the environment outlives everything the call spawns.
 * @template T
 * @param {Record<string, string>} overrides
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withEnv(overrides, fn) {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));

  try {
    Object.assign(process.env, overrides);
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * @template T
 * @param {string} home
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
function underLaunchdPath(home, fn) {
  return withEnv({ HOME: home, PATH: LAUNCHD_PATH }, fn);
}

module.exports = {
  LAUNCHD_PATH,
  tempHome,
  writeFakeCli,
  writeFallbackCli,
  withEnv,
  underLaunchdPath,
};
