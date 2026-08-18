'use strict';
// Local access to the server-distributed normalization tables. The overlay
// arrives ONLY as a payload on the existing ingest ACK (src/upload/index.js) —
// no separate network channel exists, and a disabled-upload install simply
// runs on the repo defaults in src/tech-normalize.js forever.
//
// The overlay is re-validated here on every load: the file crosses a trust
// boundary (cloud-writable → influences local naming), so even a hand-edited
// or corrupted file degrades to defaults instead of poisoning matching.
const fs = require('fs');
const { paths } = require('./paths');
const { readJson, writeJsonAtomic } = require('./util/jsonfile');
const { DEFAULTS, createNormalizer, mergeTables, validateOverlay } = require('./tech-normalize');

let cache = null; // { mtimeMs, normalizer }

function fileMtime() {
  try {
    return fs.statSync(paths.teamConfig).mtimeMs;
  } catch (e) {
    return 0;
  }
}

function normalizer() {
  const mtimeMs = fileMtime();
  if (cache && cache.mtimeMs === mtimeMs) return cache.normalizer;
  let tables = DEFAULTS;
  if (mtimeMs) {
    const v = validateOverlay(readJson(paths.teamConfig, null));
    if (v.ok) tables = mergeTables(DEFAULTS, v.value);
  }
  cache = { mtimeMs, normalizer: createNormalizer(tables) };
  return cache.normalizer;
}

function currentVersion() {
  return normalizer().version;
}

// Persist a validated overlay from the server. Returns true when the stored
// version actually changed (callers use that to trigger a rederive sweep).
function store(overlayRaw) {
  const v = validateOverlay(overlayRaw);
  if (!v.ok) return { changed: false, errors: v.errors };
  if (String(v.value.version) === String(currentVersion())) return { changed: false, errors: [] };
  writeJsonAtomic(paths.teamConfig, v.value);
  cache = null;
  return { changed: true, errors: v.errors };
}

// Version-applied marker for the rederive sweep (kept outside session state).
function appliedVersion() {
  const m = readJson(paths.teamConfigApplied, null);
  return m && m.version !== undefined ? m.version : null;
}

function markApplied() {
  writeJsonAtomic(paths.teamConfigApplied, { version: currentVersion(), applied_at: new Date().toISOString() });
}

module.exports = { normalizer, currentVersion, store, appliedVersion, markApplied };
