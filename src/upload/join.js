'use strict';
// One-time machine enrollment: `node src/cli.js join <url> <code>`.
//
// POSTs this machine's identity + the enroll code to the team endpoint,
// receives a per-machine upload credential, and writes the config.json upload
// block — this call is what CREATES the upload opt-in (upload.enabled flips
// true as its result). It rides the same host as the upload channel
// (CLAUDE.md rule 2, channel b) and is egress-logged like every other attempt
// on that channel.
const config = require('../config');
const egress = require('../classify/egress');
const { machineIdentity } = require('./identity');
const { enrollUrl, endpointHost } = require('./endpoints');

const TIMEOUT_MS = 15 * 1000;

async function join(url, code) {
  const endpoint = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint)) throw new Error('usage: join <https://team-endpoint> <enroll-code>');
  if (!code || !/^[A-Za-z0-9_-]{20,}$/.test(code)) throw new Error('that does not look like an enroll code — copy the whole join command from your dashboard');

  const machine = machineIdentity();
  const entry = { kind: 'enroll', endpoint_host: endpointHost(endpoint), machine_id: machine.machine_id };
  const t0 = Date.now();
  let res;
  let json = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    res = await fetch(enrollUrl(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, code, machine }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    try {
      json = await res.json();
    } catch (e) {
      /* non-JSON error body */
    }
    entry.http_status = res.status;
    entry.duration_ms = Date.now() - t0;
    entry.outcome = res.ok ? 'ok' : `http_${res.status}`;
    egress.record(entry);
  } catch (e) {
    entry.duration_ms = Date.now() - t0;
    entry.outcome = e.name === 'AbortError' ? 'timeout' : 'network_error';
    entry.error = String(e.message || e).slice(0, 200);
    egress.record(entry);
    throw new Error(`could not reach ${endpoint}: ${entry.error}`);
  }
  if (!res.ok || !json || !json.machine_token) {
    throw new Error(`enrollment refused (${res.status}): ${(json && (json.error || JSON.stringify(json.errors))) || 'unknown error'}`);
  }

  // The credential lives ONLY here (the server stores its sha256).
  config.save({ upload: { enabled: true, endpoint: json.endpoint || endpoint, token: json.machine_token } });
  return { machine_id: machine.machine_id, org: json.org, practitioner_id: json.practitioner_id, endpoint: json.endpoint || endpoint };
}

module.exports = { join };
