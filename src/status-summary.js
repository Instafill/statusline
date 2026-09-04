'use strict';
// Rollup written by the watcher for the Claude Code status line to read.
//
// The status line re-renders constantly, so the reader must never scan the
// sessions directory, spawn anything, or make a request. The watcher — which
// already holds all of this in hand — pays that cost once per interval and
// leaves the answer in a single small file.
const fs = require('fs');
const { paths } = require('./paths');
const { writeJsonAtomic, readJson } = require('./util/jsonfile');

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function build(cfg) {
  const sessions = require('./watcher/sessions');
  const today = startOfToday();
  let active = 0;
  let queuedForClassification = 0;
  let classifiedToday = 0;
  let failed = 0;

  for (const s of sessions.listSessions()) {
    const st = s.classification_state;
    if (st === 'unclassified' || st === 'stale' || st === 'pending') queuedForClassification++;
    if (st === 'classification_failed') failed++;
    if (s.classified_at && s.classified_at >= today) classifiedToday++;
    if (s.last_event_at && s.last_event_at >= today) active++;
  }

  let spoolPending = 0;
  try {
    spoolPending = fs.readdirSync(paths.spoolNew).length;
  } catch (e) {
    /* spool may not exist yet */
  }

  return {
    v: 1,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    port: cfg && cfg.port,
    sessions_today: active,
    classified_today: classifiedToday,
    queued: queuedForClassification,
    spool_pending: spoolPending,
    failed,
  };
}

function write(cfg) {
  try {
    writeJsonAtomic(paths.summary, build(cfg));
  } catch (e) {
    return false; // never let a status-line convenience break the watcher
  }
  return true;
}

// staleAfterMs guards the case that matters: the watcher died without clearing
// anything, so a summary file still exists but no longer describes reality.
function read(staleAfterMs = 90000) {
  const s = readJson(paths.summary, null);
  if (!s || !s.updated_at) return { running: false, reason: 'no summary' };
  const age = Date.now() - Date.parse(s.updated_at);
  if (!(age >= 0) || age > staleAfterMs)
    return { running: false, reason: 'stale', age_ms: age, summary: s };
  return { running: true, age_ms: age, summary: s };
}

module.exports = { build, write, read };
