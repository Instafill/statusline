'use strict';
// Renders the statusline segment for the Claude Code status line. It describes
// THIS session — what statusline has captured from it and what it concluded —
// not machine-wide totals:
//
//   ⌁ capturing · 124 tools     this session is being recorded, 124 tool uses so far
//   ⌁ classifying…              digest sent, waiting on the classifier
//   ⌁ internal · Node.js +3     this session's classification and its evidence
//   ⌁ not tracked               hooks are not reaching this session — the real alarm
//   ⌁ off                       watcher not running; events are spooling unprocessed
//
// Two hard rules, because this runs on every status-line render:
//   1. One small file read. No directory scans, no HTTP, no subprocesses.
//   2. Never throw. A broken statusline install must not break the user's
//      prompt, so every failure degrades to an empty string.
//
// Standalone by design — no imports from src/, so the segment keeps working
// while the repo is mid-edit.
//
//   node statusline-segment.js --session <id>   render for one session
//   node statusline-segment.js --color          with ANSI color
//   node statusline-segment.js --json           the underlying record
const fs = require('fs');
const os = require('os');
const path = require('path');

const STALE_AFTER_MS = 90000;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };

function homeDir() {
  return process.env.STATUSLINE_HOME || path.join(os.homedir(), '.statusline');
}

function readSummary() {
  try {
    const raw = fs.readFileSync(path.join(homeDir(), 'summary.json'), 'utf8');
    const s = JSON.parse(raw);
    if (!s || !s.updated_at) return null;
    const age = Date.now() - Date.parse(s.updated_at);
    return { summary: s, age, running: age >= 0 && age <= STALE_AFTER_MS };
  } catch (e) {
    return null; // not installed, not running, or unreadable — all the same here
  }
}

// session_id comes from the hook payload, so it is sanitized the same way the
// watcher sanitizes it before being used as a filename.
function safeSessionId(sid) {
  return String(sid).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
}

function readSession(sessionId) {
  if (!sessionId) return null;
  try {
    const f = path.join(homeDir(), 'sessions', safeSessionId(sessionId) + '.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null; // not recorded (yet)
  }
}

// Work categories are stored as snake_case; the status line has no room for
// "internal_work" when "internal" carries the same meaning at a glance.
const CATEGORY_SHORT = {
  client_work: 'client',
  internal_work: 'internal',
  learning: 'learning',
  personal: 'personal',
  unknown: 'unclassified',
};

function classificationBits(cls, paint) {
  const cat = CATEGORY_SHORT[cls.work_category] || cls.work_category || 'classified';
  const techs = Array.isArray(cls.technologies) ? cls.technologies : [];
  const names = techs.map((t) => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
  if (!names.length) return [cat];
  const extra = names.length > 1 ? paint(C.dim, ` +${names.length - 1}`) : '';
  return [cat, names[0] + extra];
}

function render({ color = false, sessionId = null } = {}) {
  const paint = (c, s) => (color ? c + s + C.reset : s);
  const state = readSummary();
  if (!state) return ''; // statusline not installed on this machine: show nothing
  if (!state.running) return paint(C.red, '⌁ off');

  const session = readSession(sessionId);
  if (!session) {
    // The watcher is alive but has nothing for this session. Right after
    // SessionStart that is simply a race, so stay quiet unless a session id was
    // supplied and still produced nothing.
    return sessionId ? `${paint(C.yellow, '⌁')} ${paint(C.dim, 'not tracked')}` : '';
  }

  let bits;
  let head = C.green;
  switch (session.classification_state) {
    case 'classified':
      bits = session.classification ? classificationBits(session.classification, paint) : ['classified'];
      break;
    case 'pending':
      bits = [paint(C.dim, 'classifying…')];
      break;
    case 'classification_failed':
      head = C.red;
      bits = ['classify failed'];
      break;
    default: {
      // Live session: confirm capture, and show the evidence count that will
      // drive the classification.
      const tools = (session.counts && session.counts.tool_uses) || 0;
      const prompts = (session.counts && session.counts.prompts) || 0;
      const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      bits = ['capturing'];
      if (tools) bits.push(plural(tools, 'tool'));
      else if (prompts) bits.push(plural(prompts, 'prompt'));
    }
  }

  return `${paint(head, '⌁')} ${bits.join(paint(C.dim, ' · '))}`;
}

if (require.main === module) {
  try {
    const i = process.argv.indexOf('--session');
    const sessionId = i !== -1 ? process.argv[i + 1] : null;
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify({ watcher: readSummary(), session: readSession(sessionId) }, null, 2) + '\n');
    } else {
      process.stdout.write(render({ color: process.argv.includes('--color'), sessionId }));
    }
  } catch (e) {
    /* never break the prompt */
  }
}

module.exports = { render, readSummary, readSession };
