'use strict';
// `upload.endpoint` has two legitimate shapes and both must work:
//   - the deployment ORIGIN — what `cli.js join` stores (the server returns
//     its APP_URL) and what people naturally paste from a dashboard;
//   - a full ingest URL ending in /v1/ingest — what hand-written configs used
//     before enrollment existed.
// Everything that talks to the team endpoint resolves through here, so a
// config written by either era keeps working.

function baseOf(endpoint) {
  const raw = String(endpoint || '')
    .trim()
    .replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/v1\/(ingest|enroll)$/, '').replace(/\/+$/, '');
    return u.origin + path;
  } catch (e) {
    return raw; // not a URL — callers surface the failure
  }
}

const ingestUrl = (endpoint) => `${baseOf(endpoint)}/v1/ingest`;
const enrollUrl = (endpoint) => `${baseOf(endpoint)}/v1/enroll`;

function endpointHost(endpoint) {
  try {
    return new URL(baseOf(endpoint)).host;
  } catch (e) {
    return String(endpoint || '');
  }
}

module.exports = { baseOf, ingestUrl, enrollUrl, endpointHost };
