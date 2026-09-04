'use strict';
// The health endpoint is what `doctor` reads to answer whether the watcher can
// reach the classifier. The watcher is the only process that knows: it resolved
// the CLI in the environment it was actually launched from.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-health-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { ensureDirs, paths } = require('../src/paths');
const config = require('../src/config');
const { createApi } = require('../src/server/api');

ensureDirs();

const health = () =>
  createApi({ scheduler: null, startedAt: new Date().toISOString() })['GET /api/health']();

test('health reports a configured CLI path verbatim', () => {
  const configured = path.join(TESTHOME, 'bin', 'claude');
  fs.writeFileSync(paths.config, JSON.stringify({ classifier: { cli_path: configured } }));

  const res = health();

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.classifier_cli, configured);
});

test(
  'health reports the path resolution actually found',
  { skip: process.platform === 'win32' },
  () => {
    // The default cli_path is the bare name, so this is the branch that has to
    // do the work. An unreachable CLI publishes null rather than a guess.
    fs.writeFileSync(paths.config, JSON.stringify({ classifier: { cli_path: 'claude' } }));
    // Config is cached per process, which is why changing cli_path on a real
    // machine needs a watcher restart.
    config.load(true);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-health-home-'));
    const realHome = process.env.HOME;
    const realPath = process.env.PATH;

    try {
      process.env.HOME = home;
      process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
      assert.strictEqual(health().classifier_cli, null);
    } finally {
      process.env.HOME = realHome;
      process.env.PATH = realPath;
    }
  }
);
