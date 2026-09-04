'use strict';
// upload.endpoint accepts BOTH shapes — the origin that `cli.js join` stores
// and the full /v1/ingest URL hand-written configs used before enrollment
// existed. Regression: join once stored an origin while the uploader POSTed
// the config value verbatim, which silently broke uploads after enrolling.
const os = require('os');
const path = require('path');
const fs = require('fs');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-ep-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test } = require('node:test');
const assert = require('node:assert');
const { baseOf, ingestUrl, enrollUrl, endpointHost } = require('../src/upload/endpoints');

const APP = 'https://statusline-acme.azurewebsites.net';

test('origin, trailing slash and full ingest URL all resolve to the same calls', () => {
  for (const form of [APP, `${APP}/`, `${APP}/v1/ingest`, `${APP}/v1/enroll`]) {
    assert.strictEqual(baseOf(form), APP, form);
    assert.strictEqual(ingestUrl(form), `${APP}/v1/ingest`, form);
    assert.strictEqual(enrollUrl(form), `${APP}/v1/enroll`, form);
    assert.strictEqual(endpointHost(form), 'statusline-acme.azurewebsites.net', form);
  }
});

test('a deployment under a sub-path keeps its prefix', () => {
  assert.strictEqual(
    ingestUrl('https://example.net/statusline'),
    'https://example.net/statusline/v1/ingest'
  );
  assert.strictEqual(
    ingestUrl('https://example.net/statusline/v1/ingest'),
    'https://example.net/statusline/v1/ingest'
  );
});

test('junk degrades without throwing (callers surface the failure)', () => {
  assert.strictEqual(baseOf('not-a-url'), 'not-a-url');
  assert.strictEqual(endpointHost('not-a-url'), 'not-a-url');
  assert.strictEqual(baseOf(''), '');
  assert.strictEqual(baseOf(null), '');
});
