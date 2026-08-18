'use strict';
// Drains the spool directory that hooks/hook-forward.js writes into.
const fs = require('fs');
const path = require('path');
const { paths } = require('../paths');
const sessions = require('./sessions');
const log = require('../util/log');

// Spool filenames are `<epochMs>-<pid>-<rand>.json`; the timestamp doubles as
// the event's received-at time and its dedupe id.
function receivedAtOf(fileName) {
  const ms = parseInt(fileName.split('-')[0], 10);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function quarantine(file, reason) {
  const dest = path.join(paths.spoolQuarantine, path.basename(file));
  try {
    fs.renameSync(file, dest);
    log.warn(`quarantined spool file ${path.basename(file)}: ${reason}`);
  } catch (e) {
    log.error(`failed to quarantine ${file}: ${e.message}`);
  }
}

// Processes every file currently in spool/new. Returns affected session ids.
function drainOnce() {
  let names;
  try {
    names = fs.readdirSync(paths.spoolNew);
  } catch (e) {
    return { sessions: [], ingested: 0, quarantined: 0 };
  }
  names.sort(); // timestamp prefix → chronological ingestion
  const touched = new Set();
  let ingested = 0;
  let quarantined = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(paths.spoolNew, name);
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch (e) {
      continue; // likely mid-rename; next drain gets it
    }
    const fileId = name.replace(/\.json$/, '');
    try {
      const sid = sessions.ingestBuffer(buf, fileId, receivedAtOf(name));
      touched.add(sid);
      ingested++;
      fs.unlinkSync(file);
    } catch (e) {
      quarantined++;
      quarantine(file, e.message);
    }
  }
  // Fold once per touched session (events for a session were appended above; a
  // crash before this fold is repaired by the next drain/fold of that session).
  for (const sid of touched) {
    try {
      sessions.foldSession(sid);
    } catch (e) {
      log.error(`fold failed for session ${sid}: ${e.message}`);
    }
  }
  return { sessions: [...touched], ingested, quarantined };
}

module.exports = { drainOnce };
