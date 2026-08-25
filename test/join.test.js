'use strict';
// Local `cli.js join`: enrolls against a stub endpoint, writes the config
// upload block, and egress-logs the attempt. Isolated STATUSLINE_HOME.
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const TESTHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'statusline-join-'));
process.env.STATUSLINE_HOME = TESTHOME;

const { test, before, after } = require('node:test');
const assert = require('node:assert');

let stub;
let base;
let lastEnrollBody = null;
let respond = null;

let lastEnrollPath = null;

before(async () => {
  stub = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      lastEnrollPath = req.url;
      lastEnrollBody = JSON.parse(data);
      const [status, body] = respond(lastEnrollBody);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${stub.address().port}`;
});

after(() => stub.close());

test('join enrolls, persists the credential, and egress-logs the call', async () => {
  respond = (_body) => [
    200,
    {
      ok: true,
      endpoint: base,
      machine_token: 'issued-machine-token',
      practitioner_id: 'prac_ab12cd34ef',
      org: { id: 'org_testco', name: 'TestCo' },
    },
  ];
  const { join } = require('../src/upload/join');
  const r = await join(`${base}/`, 'enroll-code-1234567890abcdef');

  // The machine identity it sent is the persisted machine.json UUID.
  const machineFile = JSON.parse(fs.readFileSync(path.join(TESTHOME, 'machine.json'), 'utf8'));
  assert.strictEqual(lastEnrollBody.machine.machine_id, machineFile.machine_id);
  assert.strictEqual(lastEnrollBody.v, 1);
  assert.strictEqual(lastEnrollBody.code, 'enroll-code-1234567890abcdef');
  assert.strictEqual(r.org.name, 'TestCo');

  // Upload block written: enabled, endpoint normalized, credential stored.
  assert.strictEqual(lastEnrollPath, '/v1/enroll');
  const cfg = JSON.parse(fs.readFileSync(path.join(TESTHOME, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.upload.enabled, true);
  assert.strictEqual(cfg.upload.endpoint, base);
  assert.strictEqual(cfg.upload.token, 'issued-machine-token');
  // The stored value must be usable by the uploader (it posts to ingestUrl).
  const { ingestUrl } = require('../src/upload/endpoints');
  assert.strictEqual(ingestUrl(cfg.upload.endpoint), `${base}/v1/ingest`);

  // Egress trail: kind:"enroll", outcome ok.
  const lines = fs
    .readFileSync(path.join(TESTHOME, 'egress.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const entry = lines.find((l) => l.kind === 'enroll');
  assert.strictEqual(entry.outcome, 'ok');
  // host, not hostname: the privacy log names the exact endpoint contacted.
  assert.strictEqual(entry.endpoint_host, new URL(base).host);
});

test('a refused enrollment logs the failure and leaves uploads untouched', async () => {
  respond = () => [400, { error: 'invalid, expired or already-used enroll code' }];
  const { join } = require('../src/upload/join');
  await assert.rejects(
    () => join(base, 'enroll-code-1234567890abcdef'),
    /enrollment refused \(400\)/
  );

  const cfg = JSON.parse(fs.readFileSync(path.join(TESTHOME, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.upload.token, 'issued-machine-token', 'previous credential untouched');
  const lines = fs
    .readFileSync(path.join(TESTHOME, 'egress.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.strictEqual(lines.filter((l) => l.kind === 'enroll').length, 2);
  assert.strictEqual(lines[lines.length - 1].outcome, 'http_400');
});

test('join validates its inputs before touching the network', async () => {
  const { join } = require('../src/upload/join');
  await assert.rejects(() => join('not-a-url', 'enroll-code-1234567890abcdef'), /usage: join/);
  await assert.rejects(() => join(base, 'short'), /enroll code/);
});
