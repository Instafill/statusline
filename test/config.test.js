'use strict';
// Config durability. Regression from 2026-08-17: a config saved as UTF-8 WITH
// BOM (PowerShell's Set-Content -Encoding utf8, Notepad, VS Code) failed to
// parse, and load() then REPLACED the file with DEFAULTS — destroying the
// upload credential and every local preference on a live machine.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-cfg-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const config = require('../src/config');
const { paths } = require('../src/paths');
const { readJson } = require('../src/util/jsonfile');

const CUSTOM = {
  v: 1,
  port: 45999,
  idle_minutes: 3,
  upload: {
    enabled: true,
    endpoint: 'https://team.example.net',
    token: 'precious-credential',
    debounce_ms: 10000,
    include_content: true,
  },
};

test('a UTF-8 BOM does not hide the config', () => {
  fs.writeFileSync(paths.config, '﻿' + JSON.stringify(CUSTOM, null, 2), 'utf8');
  const cfg = config.load(true);
  assert.strictEqual(cfg.port, 45999);
  assert.strictEqual(cfg.idle_minutes, 3);
  assert.strictEqual(cfg.upload.token, 'precious-credential');
  // Defaults still fill the gaps the overlay omits.
  assert.strictEqual(cfg.classifier.model, 'opus');
});

test('an unparseable config is left ON DISK and never replaced by defaults', () => {
  const broken = '{ "port": 45999, oops';
  fs.writeFileSync(paths.config, broken, 'utf8');
  const cfg = config.load(true);
  assert.strictEqual(cfg.port, 45817, 'runs on defaults in memory');
  assert.strictEqual(
    fs.readFileSync(paths.config, 'utf8'),
    broken,
    'the operator keeps their file and can fix it'
  );
});

test('a missing config is seeded with defaults (first run)', () => {
  fs.unlinkSync(paths.config);
  const cfg = config.load(true);
  assert.strictEqual(cfg.port, 45817);
  assert.strictEqual(readJson(paths.config, null).port, 45817, 'seeded on disk');
});

test('the beep ships off, and enabling it keeps the rest of its defaults', () => {
  fs.writeFileSync(paths.config, JSON.stringify({ beep: { enabled: true } }), 'utf8');
  const cfg = config.load(true);
  assert.strictEqual(cfg.beep.enabled, true);
  assert.strictEqual(cfg.beep.on_stop, true, 'sub-defaults survive a partial overlay');
  assert.strictEqual(cfg.beep.min_interval_ms, 1500);
  assert.strictEqual(config.DEFAULTS.beep.enabled, false, 'nobody starts beeping without asking');
});

test('save merges into the existing file without dropping unrelated keys', () => {
  fs.writeFileSync(paths.config, JSON.stringify(CUSTOM, null, 2), 'utf8');
  config.load(true);
  const saved = config.save({ upload: { endpoint: 'https://moved.example.net' } });
  assert.strictEqual(saved.upload.endpoint, 'https://moved.example.net');
  assert.strictEqual(
    saved.upload.token,
    'precious-credential',
    'credential survives an endpoint change'
  );
  assert.strictEqual(saved.port, 45999, 'unrelated settings survive');
});
