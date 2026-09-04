'use strict';
const fs = require('fs');
const path = require('path');

// The BOM strip is load-bearing on Windows: Notepad, VS Code's "UTF-8 with
// BOM" and PowerShell's `Set-Content -Encoding utf8` all prepend U+FEFF, and
// JSON.parse rejects it — a hand-edited config would otherwise read as
// unparseable. `exists` lets callers distinguish "no file" from "bad file".
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    return fallback;
  }
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (e) {
    return false;
  }
}

// Atomic-on-Windows write: temp file in the same directory, then rename
// (libuv uses MOVEFILE_REPLACE_EXISTING, so rename replaces the target).
function writeJsonAtomic(file, obj) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e) {
      // skip corrupt lines; the fold treats the log as best-effort
    }
  }
  return out;
}

module.exports = { readJson, fileExists, writeJsonAtomic, appendJsonl, readJsonl };
